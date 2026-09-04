import { randomUUID } from "crypto";
import { pool } from "../pool";
import { notifyWeddingCollaborators } from "./notifications";
import { RULE_WEIGHT_CONFIG } from "@seatwise/shared";

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
  // FR-9.4: set when this version was created by restoring an earlier one — the number (not the
  // id) is what's useful to show, so the UI never has to cross-reference another version's row.
  restoredFromVersionNumber: number | null;
  // FR-3.4 AC: the wedding's Side-Mixing setting and the soft-rule weighting-config version in
  // effect when this version was generated — null on a version created before this field existed.
  sideMixingSetting: string | null;
  ruleConfigVersion: number | null;
}

export interface ModifiedSinceApproval {
  active: boolean;
  firstModifiedAt: Date | null;
  latestModifiedAt: Date | null;
}

export class PlanVersionStatusError extends Error {}
export class ManualMoveError extends Error {}
export class AttendanceError extends Error {}
export class SwapError extends Error {}
export class RestoreError extends Error {}

export interface RestorePreview {
  sourceVersionNumber: number;
  keptCount: number;
  droppedGuests: { guestId: string; guestName: string; reason: string }[];
  unassignedGuestIds: string[];
  isComplete: boolean;
  warnings: string[];
}

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
    // FR-3.4 AC: "each Plan Version records the setting and weighting-configuration version
    // used" -- optional so older call sites (and tests) that don't pass these still work.
    sideMixingSetting?: string;
    ruleConfigVersion?: number;
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
      `INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", status, "isComplete", "sideMixingSetting", "ruleConfigVersion")
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6)`,
      [
        planVersionId,
        weddingId,
        versionNumber,
        input.isComplete,
        input.sideMixingSetting ?? null,
        input.ruleConfigVersion ?? null,
      ]
    );

    // FR-3.4 AC: make sure this ruleConfigVersion's actual weighting config is on record for this
    // wedding (idempotent -- a version that's already there from an earlier generation is left
    // untouched, since the whole point of versioning it is that past plans keep pointing at the
    // config that actually produced them).
    if (input.ruleConfigVersion !== undefined) {
      await client.query(
        `INSERT INTO "rule_weight_configs" (id, "weddingId", version, config)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("weddingId", version) DO NOTHING`,
        [randomUUID(), weddingId, input.ruleConfigVersion, JSON.stringify(RULE_WEIGHT_CONFIG)]
      );
    }

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
              (SELECT COUNT(*)::int FROM "guests" WHERE "weddingId" = pv."weddingId" AND "dayOfAttendance" = 'ATTENDING') -
              COALESCE(sa.count, 0)::int,
              0
            ) AS "unassignedGuestCount",
            restored_from."versionNumber" AS "restoredFromVersionNumber"
     FROM "plan_versions" pv
     LEFT JOIN (
       SELECT "planVersionId", COUNT(DISTINCT "guestId") AS count FROM "seat_assignments" GROUP BY "planVersionId"
     ) sa ON sa."planVersionId" = pv.id
     LEFT JOIN "plan_versions" restored_from ON restored_from.id = pv."restoredFromId"
     WHERE pv."weddingId" = $1
     ORDER BY pv."versionNumber" DESC`,
    [weddingId]
  );
  return rows;
}

// TS-13/FR-10.2: several notification triggers ("post-approval") need to know whether the
// wedding's Current Plan Version is currently Approved — used by guest add/remove routes, which
// otherwise have no reason to touch plan_versions at all.
export async function getCurrentPlanVersionStatus(weddingId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT status FROM "plan_versions" WHERE "weddingId" = $1 ORDER BY "versionNumber" DESC LIMIT 1`,
    [weddingId]
  );
  return rows[0]?.status ?? null;
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

  // FR-10.2: a status change to IN_REVIEW is "the plan is shared for review"; any other status
  // transition is notified as a plain status change.
  await notifyWeddingCollaborators(
    weddingId,
    actorUserId,
    newStatus === "IN_REVIEW" ? "PLAN_SHARED" : "STATUS_CHANGED",
    newStatus === "IN_REVIEW"
      ? "The seating plan was shared for review."
      : `The seating plan status changed to ${newStatus}.`
  );

  return getPlanVersionDetail(id, weddingId);
}

export async function getPlanVersionDetail(
  id: string,
  weddingId: string
): Promise<PlanVersionDetail | null> {
  const { rows: versionRows } = await pool.query(
    `SELECT pv.id, pv."weddingId", pv."versionNumber", pv.label, pv.status, pv."isComplete",
            pv."approvedAt", pv."createdAt", pv."sideMixingSetting", pv."ruleConfigVersion",
            (pv."versionNumber" = (SELECT MAX("versionNumber") FROM "plan_versions" WHERE "weddingId" = $2)) AS "isCurrent",
            restored_from."versionNumber" AS "restoredFromVersionNumber"
     FROM "plan_versions" pv
     LEFT JOIN "plan_versions" restored_from ON restored_from.id = pv."restoredFromId"
     WHERE pv.id = $1 AND pv."weddingId" = $2`,
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

  // FR-8.1: a guest marked Not Attending doesn't occupy a seat and isn't counted as
  // "unassigned" — they've been excluded from the plan entirely, not left pending.
  const { rows: allGuests } = await pool.query(
    `SELECT id FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'`,
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
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable", "dayOfAttendance"
     FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [guestId, weddingId]
  );
  const guest = guestRows[0];
  if (!guest) throw new ManualMoveError("Guest not found.");
  if (guest.dayOfAttendance === "NOT_ATTENDING") {
    throw new ManualMoveError(
      `${guest.name} is marked not attending — mark them attending again before seating them.`
    );
  }

  const { rows: tableRows } = await pool.query(
    `SELECT id, label, capacity, "isAccessible", "isRestricted" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2`,
    [targetTableId, weddingId]
  );
  const targetTable = tableRows[0];
  if (!targetTable) throw new ManualMoveError("Table not found.");

  // FR-3.7a: every wedding-wide required-table membership (at most one row per guest -- enforced
  // by a DB unique constraint) -- used below to block either side of a Restricted table's
  // required list being violated by a manual move.
  const { rows: requiredRows } = await pool.query(
    `SELECT rtg."guestId", rtg."tableId", t.label AS "tableLabel"
     FROM "restricted_table_guests" rtg
     JOIN "seating_tables" t ON t.id = rtg."tableId"
     WHERE t."weddingId" = $1`,
    [weddingId]
  );
  const requiredTableByGuestId = new Map<string, { tableId: string; tableLabel: string }>(
    requiredRows.map((r) => [r.guestId, { tableId: r.tableId, tableLabel: r.tableLabel }])
  );
  const requiredGuestIdsForTargetTable = new Set(
    requiredRows.filter((r) => r.tableId === targetTableId).map((r) => r.guestId)
  );

  // The guest's forced-together unit: everyone connected to them by a chain of
  // MUST_SIT_TOGETHER rules always shares a table, so moving "just" this guest really means
  // moving the whole unit.
  // Not-attending guests are excluded from the graph entirely — they don't occupy a seat, and
  // if one happens to have a MUST_SIT_TOGETHER rule with an attending guest, that rule doesn't
  // apply while they're not here (FR-8.1).
  const { rows: allGuests } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable"
     FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'`,
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
    if (r.type === "MUST_SIT_TOGETHER" && parent.has(r.guestAId) && parent.has(r.guestBId)) {
      union(r.guestAId, r.guestBId);
    }
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
  // FR-3.7a: a guest required at a Restricted table can only ever be moved to that exact table
  // (or unassigned) -- never anywhere else, since that would "remove" them from the list's
  // seating without actually taking them off the list.
  for (const member of unit) {
    const required = requiredTableByGuestId.get(member.id);
    if (required && required.tableId !== targetTableId) {
      throw new ManualMoveError(
        `${member.name} is required at "${required.tableLabel}" and can't be moved elsewhere ` +
          `while they're on its required-guest list.`
      );
    }
  }
  // FR-3.7a: a Restricted table can only ever hold the guests on its required list -- moving
  // anyone else there is blocked, the same as moving a listed guest away from it above.
  if (targetTable.isRestricted) {
    const unlisted = unit.filter((member) => !requiredGuestIdsForTargetTable.has(member.id));
    if (unlisted.length > 0) {
      const names = unlisted.map((g) => g.name).join(", ");
      throw new ManualMoveError(
        `"${targetTable.label}" is a Restricted table — only guests on its required-guest list ` +
          `can be seated there, and ${names} ${unlisted.length === 1 ? "isn't" : "aren't"} on it.`
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
      `SELECT
         (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
            AND NOT EXISTS (
              SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id
            )
         ) AS "count",
         -- FR-4.6: a guest flagged Needs Reassignment elsewhere in this plan (e.g. a table they
         -- need was unmarked Accessible) also keeps the plan incomplete -- this move alone
         -- shouldn't silently clear an unrelated outstanding issue.
         (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
           AS "needsReassignmentCount"`,
      [weddingId, planVersionId]
    );
    const isComplete =
      unassignedCountRows[0].count === 0 && unassignedCountRows[0].needsReassignmentCount === 0;
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

  // FR-10.2: table changes are only notification-worthy once the plan has been approved (a Draft
  // is expected to be edited constantly and would otherwise spam everyone).
  if (planVersion.status === "APPROVED") {
    await notifyWeddingCollaborators(
      weddingId,
      actorUserId,
      "TABLE_CHANGED",
      `${unit.map((g) => g.name).join(", ")} moved to "${targetTable.label}".`
    );
  }

  return { planVersion, warnings };
}

// FR-8.1 (Day-Of Mode): flip a guest's same-day attendance signal, independent of rsvpStatus —
// a guest can RSVP Confirmed weeks ahead and still no-show, or walk in unannounced. Marking
// someone Not Attending frees their seat immediately against the Current Plan Version (no full
// regeneration, nobody else moves) and excludes them from unassigned/completeness counts
// entirely — they're not "pending," they're not here today. Reverting to Attending does NOT
// auto-seat them back: per FR-8.1 they come back as Unassigned until someone explicitly (re)seats
// them, since their old table may no longer have room or may no longer be the right call.
export async function setGuestAttendance(
  weddingId: string,
  guestId: string,
  attendance: "ATTENDING" | "NOT_ATTENDING",
  actorUserId: string
): Promise<PlanVersionDetail | null> {
  const { rows: guestRows } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, "dayOfAttendance"
     FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [guestId, weddingId]
  );
  const guest = guestRows[0];
  if (!guest) throw new AttendanceError("Guest not found.");

  const { rows: currentRows } = await pool.query(
    `SELECT id FROM "plan_versions" WHERE "weddingId" = $1 ORDER BY "versionNumber" DESC LIMIT 1`,
    [weddingId]
  );
  const currentPlanVersionId: string | undefined = currentRows[0]?.id;

  if (guest.dayOfAttendance === attendance) {
    // Already at the requested attendance — no-op, just return current state.
    return currentPlanVersionId ? getPlanVersionDetail(currentPlanVersionId, weddingId) : null;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE "guests" SET "dayOfAttendance" = $1::"DayOfAttendance", "updatedAt" = now() WHERE id = $2`,
      [attendance, guestId]
    );

    if (currentPlanVersionId) {
      if (attendance === "NOT_ATTENDING") {
        await client.query(
          `DELETE FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2`,
          [currentPlanVersionId, guestId]
        );
      }
      // Recompute completeness against the new attendance-filtered denominator — a guest who
      // just became NOT_ATTENDING can no longer make the plan "incomplete" by being unseated,
      // and one who just became ATTENDING again can.
      const { rows: unassignedCountRows } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
              AND NOT EXISTS (
                SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id
              )
           ) AS "count",
           -- FR-4.6: don't let an attendance change silently clear an unrelated Needs
           -- Reassignment flag from elsewhere in the plan.
           (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
             AS "needsReassignmentCount"`,
        [weddingId, currentPlanVersionId]
      );
      const isComplete =
        unassignedCountRows[0].count === 0 && unassignedCountRows[0].needsReassignmentCount === 0;
      await client.query(`UPDATE "plan_versions" SET "isComplete" = $1 WHERE id = $2`, [
        isComplete,
        currentPlanVersionId,
      ]);

      const description =
        attendance === "NOT_ATTENDING"
          ? `${guest.name} marked not attending — seat freed`
          : `${guest.name} marked attending again — now unassigned`;
      await client.query(
        `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId")
         VALUES ($1, $2, 'ATTENDANCE_CHANGE', $3, $4)`,
        [randomUUID(), currentPlanVersionId, description, actorUserId]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const detail = currentPlanVersionId ? await getPlanVersionDetail(currentPlanVersionId, weddingId) : null;

  // FR-10.2: attendance changes are only notification-worthy once the plan has been approved.
  if (detail?.status === "APPROVED") {
    await notifyWeddingCollaborators(
      weddingId,
      actorUserId,
      "ATTENDANCE_CHANGED",
      attendance === "NOT_ATTENDING"
        ? `${guest.name} was marked not attending.`
        : `${guest.name} was marked attending again.`
    );
  }

  return detail;
}

// FR-8.1 (Day-Of Mode): swap two guests' (or their forced-together units') tables in one atomic
// move — e.g. "put the Smiths where the Johnsons are, and vice versa" — instead of the two-step
// dance of moving one to a holding spot first. Both directions are validated against every hard
// rule (capacity, accessible-table, must-not-sit-together) using each other's post-swap
// occupancy *before* anything changes; if either direction would fail, the whole swap is blocked
// with a specific explanation and nothing changes. AVOID conflicts in either direction are
// allowed but returned as non-blocking warnings. Only attending guests already fully and
// consistently seated (their whole forced-together unit at one table) can be swapped.
export async function swapGuestAssignments(
  planVersionId: string,
  weddingId: string,
  guestAId: string,
  guestBId: string,
  actorUserId: string
): Promise<ManualMoveResult> {
  if (!(await isCurrentVersion(planVersionId, weddingId))) {
    throw new SwapError(
      "Only the current plan version can be manually edited — this one has been superseded."
    );
  }
  if (guestAId === guestBId) {
    throw new SwapError("Can't swap a guest with themselves.");
  }

  const { rows: allGuests } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable"
     FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'`,
    [weddingId]
  );
  const guestsById = new Map(allGuests.map((g) => [g.id, g]));
  const guestA = guestsById.get(guestAId);
  const guestB = guestsById.get(guestBId);
  if (!guestA) throw new SwapError("First guest not found, or not currently attending.");
  if (!guestB) throw new SwapError("Second guest not found, or not currently attending.");

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
    if (r.type === "MUST_SIT_TOGETHER" && parent.has(r.guestAId) && parent.has(r.guestBId)) {
      union(r.guestAId, r.guestBId);
    }
  }

  const rootA = find(guestAId);
  const rootB = find(guestBId);
  if (rootA === rootB) {
    throw new SwapError(
      `${guestA.name} and ${guestB.name} are in the same must-sit-together group — there's nothing to swap.`
    );
  }
  const unitA = allGuests.filter((g) => find(g.id) === rootA);
  const unitB = allGuests.filter((g) => find(g.id) === rootB);
  const unitAIds = new Set(unitA.map((g) => g.id));
  const unitBIds = new Set(unitB.map((g) => g.id));

  const { rows: currentAssignmentRows } = await pool.query(
    `SELECT sa."guestId", sa."seatingTableId" AS "tableId"
     FROM "seat_assignments" sa WHERE sa."planVersionId" = $1`,
    [planVersionId]
  );
  const tableByGuest = new Map(currentAssignmentRows.map((r) => [r.guestId, r.tableId]));

  // Both units must currently be fully and consistently seated — each entirely at one table —
  // for "swap" to be a well-defined operation.
  const unitATables = new Set(unitA.map((g) => tableByGuest.get(g.id)).filter(Boolean));
  const unitBTables = new Set(unitB.map((g) => tableByGuest.get(g.id)).filter(Boolean));
  if (unitATables.size !== 1) {
    throw new SwapError(
      `${guestA.name}'s group isn't fully seated at one table yet — seat them first before swapping.`
    );
  }
  if (unitBTables.size !== 1) {
    throw new SwapError(
      `${guestB.name}'s group isn't fully seated at one table yet — seat them first before swapping.`
    );
  }
  const tableAId = [...unitATables][0] as string;
  const tableBId = [...unitBTables][0] as string;
  if (tableAId === tableBId) {
    throw new SwapError(`${guestA.name} and ${guestB.name} are already seated at the same table.`);
  }

  const { rows: tableRows } = await pool.query(
    `SELECT id, label, capacity, "isAccessible", "isRestricted" FROM "seating_tables" WHERE id = ANY($1::text[]) AND "weddingId" = $2`,
    [[tableAId, tableBId], weddingId]
  );
  const tablesById = new Map(tableRows.map((t) => [t.id, t]));
  const tableA = tablesById.get(tableAId);
  const tableB = tablesById.get(tableBId);
  if (!tableA || !tableB) throw new SwapError("Table not found.");

  // FR-3.7a: a Restricted table's required-guest list can only change through the dedicated
  // required-guests endpoint -- swapping would move a required guest off their table (or an
  // unlisted guest onto one), either of which "violates either side of the list", so a swap
  // touching either table is blocked outright rather than trying to special-case it.
  if (tableA.isRestricted || tableB.isRestricted) {
    const restrictedLabel = tableA.isRestricted ? tableA.label : tableB.label;
    throw new SwapError(
      `"${restrictedLabel}" is a Restricted table — its required-guest list can't be changed by ` +
        `swapping guests in or out of it.`
    );
  }

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

  const { rows: occupantRows } = await pool.query(
    `SELECT sa."guestId", sa."seatingTableId" AS "tableId", g.headcount, g."requiresAccessibleTable",
            (g."firstName" || ' ' || g."lastName") AS name
     FROM "seat_assignments" sa
     JOIN "guests" g ON g.id = sa."guestId"
     WHERE sa."planVersionId" = $1 AND sa."seatingTableId" = ANY($2::text[])`,
    [planVersionId, [tableAId, tableBId]]
  );
  // Who's staying put at each table once its current occupant unit leaves and the other arrives.
  const stayingAtA = occupantRows.filter((o) => o.tableId === tableAId && !unitAIds.has(o.guestId));
  const stayingAtB = occupantRows.filter((o) => o.tableId === tableBId && !unitBIds.has(o.guestId));

  const headcount = (rows: { headcount: number }[]) =>
    rows.reduce((sum, r) => sum + r.headcount, 0);
  const unitAHeadcount = headcount(unitA);
  const unitBHeadcount = headcount(unitB);
  const stayingAtAHeadcount = headcount(stayingAtA);
  const stayingAtBHeadcount = headcount(stayingAtB);

  const guestNameList = (ids: string[], unit: typeof unitA) =>
    unit
      .filter((g) => ids.includes(g.id))
      .map((g) => g.name)
      .join(", ");

  // --- Hard rules, both directions, all checked before anything changes. ---
  if (stayingAtAHeadcount + unitBHeadcount > tableA.capacity) {
    throw new SwapError(
      `${guestB.name}'s group can't be seated at "${tableA.label}" — it only has ` +
        `${Math.max(tableA.capacity - stayingAtAHeadcount, 0)} seat(s) left once ${guestA.name}'s group ` +
        `moves out, but ${unitBHeadcount} ${unitBHeadcount === 1 ? "is" : "are"} needed.`
    );
  }
  if (stayingAtBHeadcount + unitAHeadcount > tableB.capacity) {
    throw new SwapError(
      `${guestA.name}'s group can't be seated at "${tableB.label}" — it only has ` +
        `${Math.max(tableB.capacity - stayingAtBHeadcount, 0)} seat(s) left once ${guestB.name}'s group ` +
        `moves out, but ${unitAHeadcount} ${unitAHeadcount === 1 ? "is" : "are"} needed.`
    );
  }
  const unitBNeedsAccessible = unitB.filter((g) => g.requiresAccessibleTable).map((g) => g.id);
  if (unitBNeedsAccessible.length > 0 && !tableA.isAccessible) {
    throw new SwapError(
      `${guestNameList(unitBNeedsAccessible, unitB)} require${
        unitBNeedsAccessible.length === 1 ? "s" : ""
      } an accessible table, and "${tableA.label}" isn't marked as one.`
    );
  }
  const unitANeedsAccessible = unitA.filter((g) => g.requiresAccessibleTable).map((g) => g.id);
  if (unitANeedsAccessible.length > 0 && !tableB.isAccessible) {
    throw new SwapError(
      `${guestNameList(unitANeedsAccessible, unitA)} require${
        unitANeedsAccessible.length === 1 ? "s" : ""
      } an accessible table, and "${tableB.label}" isn't marked as one.`
    );
  }
  for (const member of unitB) {
    const conflicts = mustNotByGuest.get(member.id);
    if (!conflicts) continue;
    const conflictingOccupant = stayingAtA.find((o) => conflicts.has(o.guestId));
    if (conflictingOccupant) {
      throw new SwapError(
        `${member.name} has a "must not sit together" rule with ${conflictingOccupant.name}, ` +
          `who's staying at "${tableA.label}".`
      );
    }
  }
  for (const member of unitA) {
    const conflicts = mustNotByGuest.get(member.id);
    if (!conflicts) continue;
    const conflictingOccupant = stayingAtB.find((o) => conflicts.has(o.guestId));
    if (conflictingOccupant) {
      throw new SwapError(
        `${member.name} has a "must not sit together" rule with ${conflictingOccupant.name}, ` +
          `who's staying at "${tableB.label}".`
      );
    }
  }

  // --- Soft rules — allowed, non-blocking warning, both directions. ---
  const warnings: string[] = [];
  for (const member of unitB) {
    const avoids = avoidByGuest.get(member.id);
    if (!avoids) continue;
    for (const occupant of stayingAtA) {
      if (avoids.has(occupant.guestId)) {
        warnings.push(
          `${member.name} and ${occupant.name} will be seated together at "${tableA.label}" ` +
            `despite an "avoid" preference between them.`
        );
      }
    }
  }
  for (const member of unitA) {
    const avoids = avoidByGuest.get(member.id);
    if (!avoids) continue;
    for (const occupant of stayingAtB) {
      if (avoids.has(occupant.guestId)) {
        warnings.push(
          `${member.name} and ${occupant.name} will be seated together at "${tableB.label}" ` +
            `despite an "avoid" preference between them.`
        );
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const member of unitB) {
      await client.query(
        `UPDATE "seat_assignments" SET "seatingTableId" = $1, "needsReassignment" = false, "updatedAt" = now()
         WHERE "planVersionId" = $2 AND "guestId" = $3`,
        [tableAId, planVersionId, member.id]
      );
    }
    for (const member of unitA) {
      await client.query(
        `UPDATE "seat_assignments" SET "seatingTableId" = $1, "needsReassignment" = false, "updatedAt" = now()
         WHERE "planVersionId" = $2 AND "guestId" = $3`,
        [tableBId, planVersionId, member.id]
      );
    }

    const description =
      `Swapped ${unitA.map((g) => g.name).join(", ")} (was at "${tableA.label}") with ` +
      `${unitB.map((g) => g.name).join(", ")} (was at "${tableB.label}")`;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId")
       VALUES ($1, $2, 'MANUAL_SWAP', $3, $4)`,
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
  if (!planVersion) throw new SwapError("Plan version not found after swap.");
  planVersion.warnings = warnings;

  // FR-10.2: same "only once approved" gating as a plain move.
  if (planVersion.status === "APPROVED") {
    await notifyWeddingCollaborators(
      weddingId,
      actorUserId,
      "TABLE_CHANGED",
      `Swapped ${unitA.map((g) => g.name).join(", ")} with ${unitB.map((g) => g.name).join(", ")}.`
    );
  }

  return { planVersion, warnings };
}

// FR-9.4 (Plan Versions vs. Change History): restoring a prior version copies its assignments
// into a brand-new version rather than rewriting history — v3..v5 (and everything's history)
// stay exactly as they were, and the restored copy becomes Current only because it's numbered
// higher, same as any other new version. Guests/tables/rules can have changed since the source
// version was made, so every one of its assignments is re-validated against *current* data
// before being copied (FR-0.1): a table that's gone, shrunk below what it now holds, lost its
// accessible flag, or a must-not-sit-together rule added since then all drop the affected guest
// back to Unassigned rather than silently keeping an assignment that's no longer valid. A
// must-sit-together rule added since the snapshot is a genuine tension with "restore exactly
// what v2 looked like" — rather than silently reshuffling the copied layout to fix it (which
// would stop being a restore), it's surfaced as a non-blocking warning instead.
async function computeRestorePlacement(sourceVersionId: string, weddingId: string) {
  const { rows: sourceRows } = await pool.query(
    `SELECT id, "versionNumber" FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2`,
    [sourceVersionId, weddingId]
  );
  const source = sourceRows[0];
  if (!source) throw new RestoreError("Source plan version not found.");

  const { rows: sourceAssignments } = await pool.query(
    `SELECT "guestId", "seatingTableId" AS "tableId" FROM "seat_assignments" WHERE "planVersionId" = $1`,
    [sourceVersionId]
  );

  const { rows: guests } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable"
     FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'`,
    [weddingId]
  );
  const guestsById = new Map(guests.map((g) => [g.id, g]));

  const { rows: tables } = await pool.query(
    `SELECT id, label, capacity, "isAccessible" FROM "seating_tables" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const tablesById = new Map(tables.map((t) => [t.id, t]));

  const { rows: rels } = await pool.query(
    `SELECT "guestAId", "guestBId", type FROM "guest_relationships" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const mustNotByGuest = new Map<string, Set<string>>();
  const mustTogetherByGuest = new Map<string, Set<string>>();
  for (const r of rels) {
    const map =
      r.type === "MUST_NOT_SIT_TOGETHER"
        ? mustNotByGuest
        : r.type === "MUST_SIT_TOGETHER"
          ? mustTogetherByGuest
          : null;
    if (!map) continue;
    if (!map.has(r.guestAId)) map.set(r.guestAId, new Set());
    map.get(r.guestAId)!.add(r.guestBId);
    if (!map.has(r.guestBId)) map.set(r.guestBId, new Set());
    map.get(r.guestBId)!.add(r.guestAId);
  }

  const kept: { guestId: string; tableId: string }[] = [];
  const droppedGuests: { guestId: string; guestName: string; reason: string }[] = [];
  const runningHeadcount = new Map<string, number>();
  const runningOccupants = new Map<string, string[]>();

  for (const a of sourceAssignments) {
    const guest = guestsById.get(a.guestId);
    if (!guest) continue; // deleted, or not attending today — simply not part of this plan

    const table = tablesById.get(a.tableId);
    if (!table) {
      droppedGuests.push({
        guestId: guest.id,
        guestName: guest.name,
        reason: "their table no longer exists",
      });
      continue;
    }
    if (guest.requiresAccessibleTable && !table.isAccessible) {
      droppedGuests.push({
        guestId: guest.id,
        guestName: guest.name,
        reason: `"${table.label}" isn't marked as an accessible table anymore`,
      });
      continue;
    }
    const currentHeadcount = runningHeadcount.get(table.id) ?? 0;
    if (currentHeadcount + guest.headcount > table.capacity) {
      droppedGuests.push({
        guestId: guest.id,
        guestName: guest.name,
        reason: `"${table.label}"'s capacity (${table.capacity}) no longer has room for them`,
      });
      continue;
    }
    const conflicts = mustNotByGuest.get(guest.id);
    const occupantsHere = runningOccupants.get(table.id) ?? [];
    const conflictingOccupantId = conflicts
      ? occupantsHere.find((id) => conflicts.has(id))
      : undefined;
    if (conflictingOccupantId) {
      const conflictingGuest = guestsById.get(conflictingOccupantId);
      droppedGuests.push({
        guestId: guest.id,
        guestName: guest.name,
        reason:
          `they now have a "must not sit together" rule with ` +
          `${conflictingGuest?.name ?? "someone"} at "${table.label}"`,
      });
      continue;
    }

    kept.push({ guestId: guest.id, tableId: table.id });
    runningHeadcount.set(table.id, currentHeadcount + guest.headcount);
    runningOccupants.set(table.id, [...occupantsHere, guest.id]);
  }

  const keptIds = new Set(kept.map((k) => k.guestId));
  const tableByKeptGuest = new Map(kept.map((k) => [k.guestId, k.tableId]));

  const warnings: string[] = [];
  const warnedPairs = new Set<string>();
  for (const [guestId, others] of mustTogetherByGuest) {
    if (!keptIds.has(guestId)) continue;
    for (const otherId of others) {
      if (!keptIds.has(otherId)) continue;
      const pairKey = [guestId, otherId].sort().join("|");
      if (warnedPairs.has(pairKey)) continue;
      if (tableByKeptGuest.get(guestId) !== tableByKeptGuest.get(otherId)) {
        warnedPairs.add(pairKey);
        const a = guestsById.get(guestId);
        const b = guestsById.get(otherId);
        warnings.push(
          `${a?.name ?? guestId} and ${b?.name ?? otherId} are now required to sit together, but ` +
            `this restored version keeps them at different tables (that rule didn't exist when ` +
            `this version was made) — move one of them manually if they should be reunited.`
        );
      }
    }
  }

  const unassignedGuestIds = guests.map((g) => g.id).filter((id) => !keptIds.has(id));

  return {
    sourceVersionNumber: source.versionNumber as number,
    kept,
    droppedGuests,
    unassignedGuestIds,
    isComplete: unassignedGuestIds.length === 0,
    warnings,
  };
}

// Dry run — computes exactly what a restore would produce without writing anything, so the UI
// can show "this is what will change" before the user confirms (FR-9.4's "becomes Current only
// after the user confirms").
export async function previewPlanVersionRestore(
  sourceVersionId: string,
  weddingId: string
): Promise<RestorePreview> {
  const result = await computeRestorePlacement(sourceVersionId, weddingId);
  return {
    sourceVersionNumber: result.sourceVersionNumber,
    keptCount: result.kept.length,
    droppedGuests: result.droppedGuests,
    unassignedGuestIds: result.unassignedGuestIds,
    isComplete: result.isComplete,
    warnings: result.warnings,
  };
}

// FR-9.4: actually perform the restore — creates a new, numbered version (the source and every
// version/history entry in between are never touched) which becomes Current simply because it's
// the newest version that exists.
export async function restorePlanVersion(
  sourceVersionId: string,
  weddingId: string,
  actorUserId: string
): Promise<ManualMoveResult> {
  const result = await computeRestorePlacement(sourceVersionId, weddingId);

  const client = await pool.connect();
  let newVersionId: string;
  try {
    await client.query("BEGIN");

    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX("versionNumber"), 0) + 1 AS "next" FROM "plan_versions" WHERE "weddingId" = $1`,
      [weddingId]
    );
    const versionNumber: number = versionRows[0].next;

    newVersionId = randomUUID();
    await client.query(
      `INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", status, "isComplete", "restoredFromId")
       VALUES ($1, $2, $3, 'DRAFT', $4, $5)`,
      [newVersionId, weddingId, versionNumber, result.isComplete, sourceVersionId]
    );

    for (const a of result.kept) {
      await client.query(
        `INSERT INTO "seat_assignments" (id, "planVersionId", "guestId", "seatingTableId", "needsReassignment", "updatedAt")
         VALUES ($1, $2, $3, $4, false, now())`,
        [randomUUID(), newVersionId, a.guestId, a.tableId]
      );
    }

    const description =
      `Restored from version ${result.sourceVersionNumber}` +
      (result.droppedGuests.length > 0
        ? ` (${result.droppedGuests.length} guest(s) left Unassigned — data has changed since then)`
        : "");
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId")
       VALUES ($1, $2, 'RESTORE', $3, $4)`,
      [randomUUID(), newVersionId, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const planVersion = await getPlanVersionDetail(newVersionId, weddingId);
  if (!planVersion) throw new RestoreError("Plan version not found after restore.");
  const warnings = [...result.warnings];
  for (const d of result.droppedGuests) {
    warnings.push(`${d.guestName} was left Unassigned — ${d.reason}.`);
  }
  planVersion.warnings = warnings;
  return { planVersion, warnings };
}
