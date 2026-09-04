import { randomUUID } from "crypto";
import { pool } from "../pool";

export interface PlanVersionRow {
  id: string;
  weddingId: string;
  versionNumber: number;
  label: string | null;
  status: string;
  isComplete: boolean;
  createdAt: Date;
  assignedGuestCount: number;
  unassignedGuestCount: number;
}

export interface PlanVersionAssignmentRow {
  id: string;
  guestId: string;
  guestName: string;
  tableId: string;
  tableLabel: string;
  needsReassignment: boolean;
}

export interface PlanVersionDetail extends PlanVersionRow {
  assignments: PlanVersionAssignmentRow[];
  unassignedGuestIds: string[];
  warnings: string[];
}

// Persists the result of generateSeatingPlan() (packages/shared/src/seating-engine.ts) as a
// new, numbered plan version — versions are immutable snapshots; regenerating never overwrites
// a prior one. Runs as a single transaction so a partial write can't leave a version with only
// some of its assignments recorded.
export async function createPlanVersionWithAssignments(
  weddingId: string,
  input: {
    isComplete: boolean;
    warnings: string[];
    assignments: { guestId: string; tableId: string }[];
    unassignedGuestIds: string[];
  }
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX("versionNumber"), 0) + 1 AS "next" FROM "plan_versions" WHERE "weddingId" = $1`,
      [weddingId]
    );
    const versionNumber: number = versionRows[0].next;

    const planVersionId = randomUUID();
    await client.query(
      `INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", status, "isComplete")
       VALUES ($1, $2, $3, 'DRAFT', $4)`,
      [planVersionId, weddingId, versionNumber, input.isComplete]
    );

    for (const a of input.assignments) {
      await client.query(
        `INSERT INTO "seat_assignments" (id, "planVersionId", "guestId", "seatingTableId", "needsReassignment", "updatedAt")
         VALUES ($1, $2, $3, $4, false, now())`,
        [randomUUID(), planVersionId, a.guestId, a.tableId]
      );
    }

    const description =
      input.assignments.length > 0
        ? `Generated version ${versionNumber}: seated ${input.assignments.length} guest(s)` +
          (input.unassignedGuestIds.length > 0
            ? `, ${input.unassignedGuestIds.length} left unassigned.`
            : ".")
        : `Generated version ${versionNumber}: no guests could be seated.`;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description)
       VALUES ($1, $2, 'GENERATE', $3)`,
      [randomUUID(), planVersionId, description]
    );

    await client.query("COMMIT");
    return planVersionId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listPlanVersionsForWedding(weddingId: string): Promise<PlanVersionRow[]> {
  const { rows } = await pool.query(
    `SELECT pv.id, pv."weddingId", pv."versionNumber", pv.label, pv.status, pv."isComplete", pv."createdAt",
            COALESCE(sa.count, 0)::int AS "assignedGuestCount",
            GREATEST(
              (SELECT COUNT(*)::int FROM "guests" WHERE "weddingId" = pv."weddingId") -
              COALESCE(sa.count, 0)::int,
              0
            ) AS "unassignedGuestCount"
     FROM "plan_versions" pv
     LEFT JOIN (
       SELECT "planVersionId", COUNT(DISTINCT "guestId") AS count FROM "seat_assignments" GROUP BY "planVersionId"
     ) sa ON sa."planVersionId" = pv.id
     WHERE pv."weddingId" = $1
     ORDER BY pv."versionNumber" DESC`,
    [weddingId]
  );
  return rows;
}

export async function getPlanVersionDetail(
  id: string,
  weddingId: string
): Promise<PlanVersionDetail | null> {
  const { rows: versionRows } = await pool.query(
    `SELECT id, "weddingId", "versionNumber", label, status, "isComplete", "createdAt"
     FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  const version = versionRows[0];
  if (!version) return null;

  const { rows: assignments } = await pool.query(
    `SELECT sa.id, sa."guestId", (g."firstName" || ' ' || g."lastName") AS "guestName",
            sa."seatingTableId" AS "tableId", t.label AS "tableLabel", sa."needsReassignment"
     FROM "seat_assignments" sa
     JOIN "guests" g ON g.id = sa."guestId"
     JOIN "seating_tables" t ON t.id = sa."seatingTableId"
     WHERE sa."planVersionId" = $1
     ORDER BY t.label, g."lastName", g."firstName"`,
    [id]
  );

  const { rows: allGuests } = await pool.query(
    `SELECT id FROM "guests" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const assignedIds = new Set(assignments.map((a) => a.guestId));
  const unassignedGuestIds = allGuests.map((g) => g.id).filter((id) => !assignedIds.has(id));

  return {
    ...version,
    assignedGuestCount: assignments.length,
    unassignedGuestCount: unassignedGuestIds.length,
    assignments,
    unassignedGuestIds,
    warnings: [],
  };
}
