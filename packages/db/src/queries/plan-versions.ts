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
export class ManualMoveError extends Error {}

export interface ManualMoveResult {
  planVersion: PlanVersionDetail;
  warnings: string[];
}

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

// FR-7.4: a locked guest's *current* table (from the latest version, whether or not it's the
// one about to be regenerated) is what a fresh generation tries to preserve.
export async function getLatestAssignmentsForWedding(
  weddingId: string
): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT sa."guestId", sa."seatingTableId" AS "tableId"
     FROM "seat_assignments" sa
     JOIN "plan_versions" pv ON pv.id = sa."planVersionId"
     WHERE pv."weddingId" = $1
       AND pv."versionNumber" = (SELECT MAX("versionNumber") FROM "plan_versions" WHERE "weddingId" = $1)`,
    [weddingId]
  );
  return new Map(rows.map((r) => [r.guestId, r.tableId]));
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

// FR-7.1/FR-7.2/FR-7.3/FR-7.6 (TS-10, Manual Adjustment): move a guest — and, since guests
// forced together by MUST_SIT_TOGETHER always share a table, their whole forced-together unit —
// to a different table within the Current Plan Version. A hard-rule violation (capacity, a
// MUST_NOT_SIT_TOGETHER conflict with whoever's already at the target, or a guest who requires
// an accessible table being sent somewhere that isn't) is rejected outright with a specific
// explanation and changes nothing; an AVOID conflict with the target table's occupants is
// allowed but returned as a non-blocking warning. Manual moves may target a restricted table —
// that's the point of "manual assignment" for those tables (see the seating-engine scoping
// note) — and are never affected by a lock (locks only change automatic generation).
export async function moveGuestAssignment(
  planVersionId: string,
  weddingId: string,
  guestId: string,
  targetTableId: string,
  actorUserId: string
): Promise<ManualMoveResult> {
  if (!(await isCurrentVersion(planVersionId, weddingId))) {
    throw new ManualMoveError(
      "Only the current plan version can be manually edited — this one has been superseded."
    );
  }

  const { rows: guestRows } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable"
     FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [guestId, weddingId]
  );
  const guest = guestRows[0];
  if (!guest) throw new ManualMoveError("Guest not found.");

  const { rows: tableRows } = await pool.query(
    `SELECT id, label, capacity, "isAccessible" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2`,
    [targetTableId, weddingId]
  );
  const targetTable = tableRows[0];
  if (!targetTable) throw new ManualMoveError("Table not found.");

  // The guest's forced-together unit: everyone connected to them by a chain of
  // MUST_SIT_TOGETHER rules always shares a table, so moving "just" this guest really means
  // moving the whole unit.
  const { rows: allGuests } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable"
     FROM "guests" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const { rows: rels } = await pool.query(
    `SELECT "guestAId", "guestBId", type FROM "guest_relationships" WHERE "weddingId" = $1`,
    [weddingId]
  );

  const parent = new Map<string, string>(allGuests.map((g) => [g.id, g.id]));
  const find = (id: string): string => {
    const p = parent.get(id);
    if (p === undefined || p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of rels) {
    if (r.type === "MUST_SIT_TOGETHER") union(r.guestAId, r.guestBId);
  }
  const root = find(guestId);
  const unit = allGuests.filter((g) => find(g.id) === root);
  const unitIds = new Set(unit.map((g) => g.id));
  const unitHeadcount = unit.reduce((sum, g) => sum + g.headcount, 0);
  const unitNeedsAccessible = unit.some((g) => g.requiresAccessibleTable);

  const mustNotByGuest = new Map<string, Set<string>>();
  const avoidByGuest = new Map<string, Set<string>>();
  for (const r of rels) {
    if (r.type === "MUST_NOT_SIT_TOGETHER" || r.type === "AVOID") {
      const map = r.type === "MUST_NOT_SIT_TOGETHER" ? mustNotByGuest : avoidByGuest;
      if (!map.has(r.guestAId)) map.set(r.guestAId, new Set());
      map.get(r.guestAId)!.add(r.guestBId);
      if (!map.has(r.guestBId)) map.set(r.guestBId, new Set());
      map.get(r.guestBId)!.add(r.guestAId);
    }
  }

  // Who else is currently at the target table in this plan version (excluding unit members,
  // who may already be seated there in a partial/inconsistent state).
  const { rows: occupantRows } = await pool.query(
    `SELECT sa."guestId", g.headcount, (g."firstName" || ' ' || g."lastName") AS name
     FROM "seat_assignments" sa
     JOIN "guests" g ON g.id = sa."guestId"
     WHERE sa."planVersionId" = $1 AND sa."seatingTableId" = $2`,
    [planVersionId, targetTableId]
  );
  const occupants = occupantRows.filter((o) => !unitIds.has(o.guestId));
  const occupantHeadcount = occupants.reduce((sum, o) => sum + o.headcount, 0);

  const guestLabel = (n: number, ids: string[]) =>
    `${n === 1 ? "Guest" : "Guests"} ${unit
      .filter((g) => ids.includes(g.id))
      .map((g) => g.name)
      .join(", ")}`;

  // --- Hard rules — any failure blocks the move outright, nothing changes. ---
  if (occupantHeadcount + unitHeadcount > targetTable.capacity) {
    throw new ManualMoveError(
      `${guestLabel(unit.length, unit.map((g) => g.id))} can't be seated at "${targetTable.label}" ` +
        `— it only has ${Math.max(targetTable.capacity - occupantHeadcount, 0)} seat(s) left, but ` +
        `${unitHeadcount} ${unitHeadcount === 1 ? "is" : "are"} needed` +
        `${unit.length > 1 ? " (everyone in this must-sit-together group moves together)" : ""}.`
    );
  }
  if (unitNeedsAccessible && !targetTable.isAccessible) {
    const needAccessible = unit.filter((g) => g.requiresAccessibleTable).map((g) => g.id);
    throw new ManualMoveError(
      `${guestLabel(needAccessible.length, needAccessible)} require${
        needAccessible.length === 1 ? "s" : ""
      } an accessible table, and "${targetTable.label}" isn't marked as one.`
    );
  }
  for (const member of unit) {
    const conflicts = mustNotByGuest.get(member.id);
    if (!conflicts) continue;
    const conflictingOccupant = occupants.find((o) => conflicts.has(o.guestId));
    if (conflictingOccupant) {
      throw new ManualMoveError(
        `${member.name} has a "must not sit together" rule with ${conflictingOccupant.name}, ` +
          `who's already seated at "${targetTable.label}".`
      );
    }
  }

  // --- Soft rules — allowed, but returned as a non-blocking warning. ---
  const warnings: string[] = [];
  for (const member of unit) {
    const avoids = avoidByGuest.get(member.id);
    if (!avoids) continue;
    for (const occupant of occupants) {
      if (avoids.has(occupant.guestId)) {
        warnings.push(
          `${member.name} and ${occupant.name} will be seated together at "${targetTable.label}" ` +
            `despite an "avoid" preference between them.`
        );
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const member of unit) {
      await client.query(
        `INSERT INTO "seat_assignments" (id, "planVersionId", "guestId", "seatingTableId", "needsReassignment", "updatedAt")
         VALUES ($1, $2, $3, $4, false, now())
         ON CONFLICT ("planVersionId", "guestId")
         DO UPDATE SET "seatingTableId" = EXCLUDED."seatingTableId", "needsReassignment" = false, "updatedAt" = now()`,
        [randomUUID(), planVersionId, member.id, targetTableId]
      );
    }

    const { rows: unassignedCountRows } = await client.query(
      `SELECT COUNT(*)::int AS "count" FROM "guests" g
       WHERE g."weddingId" = $1
         AND NOT EXISTS (
           SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id
         )`,
      [weddingId, planVersionId]
    );
    const isComplete = unassignedCountRows[0].count === 0;
    await client.query(`UPDATE "plan_versions" SET "isComplete" = $1 WHERE id = $2`, [
      isComplete,
      planVersionId,
    ]);

    const description = `Moved ${unit.map((g) => g.name).join(", ")} to "${targetTable.label}"`;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId")
       VALUES ($1, $2, 'MANUAL_MOVE', $3, $4)`,
      [randomUUID(), planVersionId, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) throw new ManualMoveError("Plan version not found after move.");
  planVersion.warnings = warnings;
  return { planVersion, warnings };
}
