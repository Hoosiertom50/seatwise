import { randomUUID } from "crypto";
import { pool } from "../pool";

export interface PlanVersionRow {
  id: string;
  weddingId: string;
  versionNumber: number;
  label: string | null;
  status: string;
  isComplete: boolean;
  approvedAt: Date | null;
  createdAt: Date;
  assignedGuestCount: number;
  unassignedGuestCount: number;
  isCurrent: boolean;
}

export interface ModifiedSinceApproval {
  active: boolean;
  firstModifiedAt: Date | null;
  latestModifiedAt: Date | null;
}

export class PlanVersionStatusError extends Error {}

const VALID_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED"] as const;
export type PlanVersionStatusValue = (typeof VALID_STATUSES)[number];

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
  modifiedSinceApproval: ModifiedSinceApproval;
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
    `SELECT pv.id, pv."weddingId", pv."versionNumber", pv.label, pv.status, pv."isComplete",
            pv."approvedAt", pv."createdAt",
            (pv."versionNumber" = (SELECT MAX("versionNumber") FROM "plan_versions" WHERE "weddingId" = pv."weddingId")) AS "isCurrent",
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

// FR-6.4: status can only ever change on the Current Plan Version (the highest versionNumber
// for the wedding) — approving or reviewing an old, superseded version makes no sense and isn't
// allowed.
async function isCurrentVersion(id: string, weddingId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT ("versionNumber" = (SELECT MAX("versionNumber") FROM "plan_versions" WHERE "weddingId" = $2)) AS "isCurrent"
     FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return rows[0]?.isCurrent ?? false;
}

// FR-6.4/FR-6.5/FR-6.6: move a plan version's review status. Approving requires a complete plan
// (FR-0.1 — an incomplete plan is never a valid, ready-to-share result) and is only ever allowed
// on the Current version. Moving away from APPROVED clears approvedAt (the "Modified Since
// Approval" indicator naturally goes inactive since it's derived from approvedAt) without
// touching any change_history_entries row — the historical record survives, per FR-6.6.
// Approval itself never locks anything (FR-6.5) — this function only ever changes the status
// column, never seat_assignments.
export async function setPlanVersionStatus(
  id: string,
  weddingId: string,
  newStatus: PlanVersionStatusValue,
  actorUserId: string
): Promise<PlanVersionDetail | null> {
  if (!(await isCurrentVersion(id, weddingId))) {
    throw new PlanVersionStatusError(
      "Only the current plan version's status can be changed — this one has been superseded."
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT status, "isComplete" FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }

    if (newStatus === "APPROVED" && !current.isComplete) {
      throw new PlanVersionStatusError(
        "This plan can't be approved yet — some guests are unassigned. Fix that first."
      );
    }
    if (current.status === newStatus) {
      await client.query("ROLLBACK");
      return getPlanVersionDetail(id, weddingId);
    }

    await client.query(
      `UPDATE "plan_versions"
       SET status = $1::"PlanVersionStatus",
           "approvedAt" = CASE WHEN $1::"PlanVersionStatus" = 'APPROVED' THEN now() ELSE NULL END
       WHERE id = $2`,
      [newStatus, id]
    );

    const description = `Status changed from ${current.status} to ${newStatus}`;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId")
       VALUES ($1, $2, 'STATUS_CHANGE', $3, $4)`,
      [randomUUID(), id, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getPlanVersionDetail(id, weddingId);
}

export async function getPlanVersionDetail(
  id: string,
  weddingId: string
): Promise<PlanVersionDetail | null> {
  const { rows: versionRows } = await pool.query(
    `SELECT id, "weddingId", "versionNumber", label, status, "isComplete", "approvedAt", "createdAt",
            ("versionNumber" = (SELECT MAX("versionNumber") FROM "plan_versions" WHERE "weddingId" = $2)) AS "isCurrent"
     FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  const version = versionRows[0];
  if (!version) return null;

  // FR-6.6: "Modified Since Approval" is active whenever this version is currently Approved and
  // a change happened after the approval timestamp (the STATUS_CHANGE entry that set APPROVED
  // itself doesn't count as a modification).
  let modifiedSinceApproval: ModifiedSinceApproval = {
    active: false,
    firstModifiedAt: null,
    latestModifiedAt: null,
  };
  if (version.status === "APPROVED" && version.approvedAt) {
    // Within the transaction that approves a version, now() (used for both approvedAt and the
    // approval's own change-history row) resolves to the same instant throughout — so a strict
    // "createdAt > approvedAt" naturally excludes that STATUS_CHANGE entry itself and only
    // finds genuine edits made afterward.
    const { rows: modRows } = await pool.query(
      `SELECT MIN("createdAt") AS "first", MAX("createdAt") AS "latest"
       FROM "change_history_entries"
       WHERE "planVersionId" = $1 AND "createdAt" > $2`,
      [id, version.approvedAt]
    );
    if (modRows[0]?.first) {
      modifiedSinceApproval = {
        active: true,
        firstModifiedAt: modRows[0].first,
        latestModifiedAt: modRows[0].latest,
      };
    }
  }

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
    modifiedSinceApproval,
  };
}
