import { randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";
import { notifyWeddingCollaborators } from "./notifications";
import {
  refreshPlanCompleteness,
  resyncTables,
  tablesAffectedBy,
  recordRecheckIfApproved,
  lockCurrentPlan,
  lockRestrictedLists,
  restrictedListsOverCapacity,
  applyAttendanceChange,
  HISTORY_CREATED_AT,
  SEAT_ORDER,
} from "./seat-checks";
import { RULE_WEIGHT_CONFIG, RULE_WEIGHT_CONFIG_VERSION, compareTableLabels } from "@seatwise/shared";

// TS-3 (FR-0.2 AC2): a soft-rule warning must name "the applied weighting-configuration version"
// -- this plan version's own recorded one if it has one (set at generation time), or the current
// live version if it doesn't (e.g. a version restored/created before ruleConfigVersion existed,
// or one that's never been regenerated since).
async function getEffectiveRuleConfigVersion(planVersionId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT "ruleConfigVersion" FROM "plan_versions" WHERE id = $1`,
    [planVersionId]
  );
  return (rows[0]?.ruleConfigVersion as number | null) ?? RULE_WEIGHT_CONFIG_VERSION;
}

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
  // FR-7.7: an optimistic-concurrency counter for this version's assignments/status/label. A
  // write that names an expectedRevision the server no longer matches is rejected as stale.
  revision: number;
}

export interface ModifiedSinceApproval {
  active: boolean;
  firstModifiedAt: Date | null;
  latestModifiedAt: Date | null;
}

// TS-197: a refusal can carry the plan as it is now (the "can't be approved yet" refusal, and a
// change refused because a newer plan replaced this one), so the screen can show it straight away.
export class PlanVersionStatusError extends Error {
  planVersion?: PlanVersionDetail;
  constructor(message: string, planVersion?: PlanVersionDetail | null) {
    super(message);
    if (planVersion) this.planVersion = planVersion;
  }
}
// TS-179: the person changing the status isn't allowed to make this particular change, judged
// against the status the plan really has under the lock (not the one read before it).
export class PlanApprovalPermissionError extends Error {}
// TS-148: the plan version isn't on this wedding at all (as opposed to being an older version).
export class PlanVersionNotFoundError extends Error {
  constructor() {
    super("Plan version not found");
  }
}
// TS-197: when the move or swap was refused because a newer plan replaced this one, planVersion is
// the plan that's current now -- Day-of and the Seating plan tab switch to it.
export class ManualMoveError extends Error {
  planVersion?: PlanVersionDetail;
  constructor(message: string, planVersion?: PlanVersionDetail | null) {
    super(message);
    if (planVersion) this.planVersion = planVersion;
  }
}
export class AttendanceError extends Error {}
export class SwapError extends Error {
  planVersion?: PlanVersionDetail;
  constructor(message: string, planVersion?: PlanVersionDetail | null) {
    super(message);
    if (planVersion) this.planVersion = planVersion;
  }
}

// TS-197: the words for a seat change sent to a plan that a newer one has replaced.
const SUPERSEDED_EDIT_MESSAGE = "Only the current plan version can be manually edited — this one has been superseded.";

// TS-197: anything reads can go through -- the pool, or a transaction's own connection (so a fresh
// copy can be read on the connection already held, instead of waiting for a second one).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field, as with pool.query.
type PlanReader = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

// TS-197: the wedding's current plan in full, or null when it has none.
async function getCurrentPlanDetail(weddingId: string, q: PlanReader = pool): Promise<PlanVersionDetail | null> {
  const { rows } = await q.query(`SELECT id FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" LIMIT 1`, [
    weddingId,
  ]);
  return rows[0] ? getPlanVersionDetail(rows[0].id as string, weddingId, q) : null;
}
export class RestoreError extends Error {}
// TS-173: a guest or table this new version seats was deleted while it was being worked out (the
// database refused the seat, 23503). Nothing was saved; trying again works from the new data.
export class PlanSourceChangedError extends Error {
  constructor() {
    super("The guest list or tables changed while this plan was being made — nothing was saved. Please try again.");
  }
}

// TS-173: inserts every seat of a new version in one statement (it was one query per guest).
// TS-181: each seat is stamped "seated at" in the order given (a millisecond apart, the column's
// precision), so SEAT_ORDER reads a generated or restored plan back in that same order.
async function insertSeats(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  planVersionId: string,
  seats: { guestId: string; tableId: string }[]
): Promise<void> {
  if (seats.length === 0) return;
  await client.query(
    `INSERT INTO "seat_assignments" (id, "planVersionId", "guestId", "seatingTableId", "needsReassignment", "updatedAt", "createdAt")
     SELECT id, $1, "guestId", "tableId", false, now(), (SELECT clock_timestamp()) + (ord * interval '1 millisecond')
     FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS x(id, "guestId", "tableId", ord)`,
    [planVersionId, seats.map(() => randomUUID()), seats.map((a) => a.guestId), seats.map((a) => a.tableId)]
  );
}

// TS-173: re-checks every table a brand-new version seats anyone at, then recounts it. The seats
// were worked out from data read before the version's transaction, so a table edit, a new rule or
// a changed list in between could otherwise leave it overfilled or breaking a rule while still
// saying "complete".
async function checkNewVersion(
  client: Parameters<typeof resyncTables>[0],
  weddingId: string,
  planVersionId: string
): Promise<void> {
  const { rows } = await client.query(
    `SELECT DISTINCT "seatingTableId" AS "tableId" FROM "seat_assignments" WHERE "planVersionId" = $1`,
    [planVersionId]
  );
  await resyncTables(client, weddingId, planVersionId, rows.map((r) => r.tableId as string));
  await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: false });
}

// FR-7.7: thrown instead of applying a write whose expectedRevision no longer matches the
// version's current one -- the fresh, up-to-date planVersion is attached so the caller can
// refresh the UI with it directly rather than making a second round-trip.
export class PlanVersionConflictError extends Error {
  planVersion: PlanVersionDetail;
  constructor(message: string, planVersion: PlanVersionDetail) {
    super(message);
    this.planVersion = planVersion;
  }
}

// FR-7.7: shared by every write that accepts an optional expectedRevision. Locks the plan
// version's row (FOR NO KEY UPDATE, inside the caller's own open transaction) so no other write can
// interleave, then compares its current revision against what the caller last saw. A mismatch
// means someone else's save landed first -- rather than proceeding on stale data, this throws
// PlanVersionConflictError with the fresh, currently-committed plan version attached (a plain
// read from a second connection isn't blocked by our row lock, so it safely sees the latest
// committed state); the caller's existing catch-and-ROLLBACK handles the rest. A caller that
// passes no expectedRevision at all (an internal/legacy call site) skips the check entirely.
async function checkPlanVersionRevision(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  planVersionId: string,
  weddingId: string,
  expectedRevision: number | undefined,
  /** TS-165: for seat edits -- the error to throw if this version is no longer the current one.
   * TS-197: given the plan that's current now, so the error can carry it. */
  superseded?: (currentPlan: PlanVersionDetail | null) => Error
): Promise<void> {
  const { rows } = await client.query(
    // TS-148: scoped to the wedding, so another wedding's version is never locked or compared.
    // TS-187: NO KEY UPDATE -- see resyncSeatsAtTable in seat-checks.ts.
    `SELECT revision, "isCurrent" FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
    [planVersionId, weddingId]
  );
  if (!rows[0]) throw new PlanVersionNotFoundError();
  // TS-165: checked again under the lock -- a Generate committing between the caller's own check
  // and here would otherwise let an edit land on a version that was just replaced.
  if (superseded && !rows[0].isCurrent) {
    // TS-197: the transaction ends first, then the plan that's current now is read on this same
    // connection and sent back with the refusal.
    await client.query("ROLLBACK").catch(() => {});
    throw superseded(await getCurrentPlanDetail(weddingId, client));
  }
  const currentRevision = rows[0].revision as number;
  if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
    // TS-187: the transaction is ended (and its locks let go) before the fresh copy is read.
    // TS-197: read on this same connection -- waiting for a second one while holding this could
    // leave every connection waiting on another when they're all busy.
    await client.query("ROLLBACK").catch(() => {});
    const fresh = await getPlanVersionDetail(planVersionId, weddingId, client);
    throw new PlanVersionConflictError(
      "This plan changed since you loaded it (maybe in another tab, or by someone else). It's been refreshed with the latest — check it and make your change again if it's still needed.",
      fresh!
    );
  }
}

export interface RestorePreview {
  sourceVersionNumber: number;
  keptCount: number;
  droppedGuests: { guestId: string; guestName: string; reason: string }[];
  unassignedGuestIds: string[];
  isComplete: boolean;
  // TS-177: of keptCount, how many will be flagged Needs Reassignment once restored.
  needsFixingCount: number;
  warnings: string[];
}

export interface ManualMoveResult {
  planVersion: PlanVersionDetail;
  warnings: string[];
}

const VALID_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED"] as const;
export type PlanVersionStatusValue = (typeof VALID_STATUSES)[number];
// TS-189: how a status reads in the plan's history (the same words the Plan tab shows).
const PLAN_STATUS_LABEL: Record<PlanVersionStatusValue, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  APPROVED: "Approved",
};

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

// TS-179: whether the wedding's current plan is approved, read inside the caller's transaction
// (which already holds the wedding lock Generate and Restore take). The current plan row is locked
// too, so a status change in progress on it finishes first and its result is what is read here.
// TS-187: the caller has already locked that row (lockCurrentPlan, right after the wedding lock);
// this reads it by id.
async function currentPlanIsApproved(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  currentPlanId: string | null
): Promise<boolean> {
  if (!currentPlanId) return false;
  const { rows } = await client.query(`SELECT status FROM "plan_versions" WHERE id = $1`, [currentPlanId]);
  return rows[0]?.status === "APPROVED";
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
    // FR-5.6: the planner's upfront choice of whether this run becomes the new Current version
    // (replacing whichever version was Current before) or a non-replacing Comparison Draft that
    // sits alongside it. Defaults to true so every existing call site keeps its old behavior.
    makeCurrent?: boolean;
    // TS-179: false when the person generating can't undo an approval (anyone but the owner or a
    // Couple member with Comment/Edit). If the current plan is approved, the new version is then
    // saved as a comparison draft and the approved plan stays current. Checked under the wedding
    // lock below, so an approval landing a moment earlier is still respected.
    mayReplaceApproved?: boolean;
  }
): Promise<{ planVersionId: string; savedAsDraftBecauseApproved: boolean; madeCurrentBecauseNoCurrentPlan: boolean }> {
  let makeCurrent = input.makeCurrent ?? true;
  let savedAsDraftBecauseApproved = false;
  let madeCurrentBecauseNoCurrentPlan = false;
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-150: one new version at a time per wedding -- two Generate (or Restore) clicks at once
    // would otherwise both take the same next version number and the second would fail.
    // TS-185: NO KEY UPDATE (here and in every other wedding lock) still lets only one of these run at
    // a time, but doesn't block Postgres's own check that a changed row's wedding exists. With a full
    // FOR UPDATE, an approval that had already changed its plan row waited here behind a Generate
    // that was itself waiting for that plan row -- each waiting for the other.
    await client.query(`SELECT id FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`, [weddingId]);
    // TS-187: then the current plan's row, in the usual order -- for a comparison draft too, so a
    // draft never runs its table re-checks while a change to the current plan is half-way through.
    const currentPlanId = await lockCurrentPlan(client, weddingId);

    // TS-189: a comparison draft of a wedding that has no current plan yet becomes the current plan
    // -- otherwise there'd be a plan nobody can approve, move guests in or export. Decided here,
    // under the wedding lock, so a plan made current a moment ago is respected.
    if (!makeCurrent && !currentPlanId) {
      makeCurrent = true;
      madeCurrentBecauseNoCurrentPlan = true;
    }

    if (makeCurrent && input.mayReplaceApproved === false && (await currentPlanIsApproved(client, currentPlanId))) {
      makeCurrent = false;
      savedAsDraftBecauseApproved = true;
    }

    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX("versionNumber"), 0) + 1 AS "next" FROM "plan_versions" WHERE "weddingId" = $1`,
      [weddingId]
    );
    const versionNumber: number = versionRows[0].next;

    // FR-5.6: unset whatever was Current first (same transaction, before the insert below) so the
    // partial unique index on ("weddingId") WHERE "isCurrent" never sees two true rows at once.
    // TS-189: the replaced version's revision is bumped, so anyone with it open (another tab, say)
    // gets "this plan changed" on their next save instead of acting on a plan that's been replaced.
    if (makeCurrent) {
      await client.query(
        `UPDATE "plan_versions" SET "isCurrent" = false, revision = revision + 1 WHERE "weddingId" = $1 AND "isCurrent"`,
        [weddingId]
      );
    }

    const planVersionId = randomUUID();
    await client.query(
      `INSERT INTO "plan_versions"
         (id, "weddingId", "versionNumber", status, "isComplete", "sideMixingSetting", "ruleConfigVersion", "isCurrent")
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7)`,
      [
        planVersionId,
        weddingId,
        versionNumber,
        input.isComplete,
        input.sideMixingSetting ?? null,
        input.ruleConfigVersion ?? null,
        makeCurrent,
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

    await insertSeats(client, planVersionId, input.assignments);
    // TS-169: the plan was worked out from the guest list as it was before this transaction; a
    // guest who declined (or was marked Not Attending) since then doesn't keep a seat in it.
    // Attendance changes take the same wedding lock, so they land either before this or after it.
    await client.query(
      `DELETE FROM "seat_assignments" WHERE "planVersionId" = $1
         AND "guestId" IN (SELECT id FROM "guests" WHERE "weddingId" = $2 AND "dayOfAttendance" <> 'ATTENDING')`,
      [planVersionId, weddingId]
    );
    await checkNewVersion(client, weddingId, planVersionId);

    // TS-189: the history counts the seats really saved (after attendance was checked again
    // above) and the attending guests really left without one -- not the engine's own numbers,
    // which were worked out from the guest list as it was before this transaction.
    const { rows: countRows } = await client.query(
      `SELECT (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $1) AS "seated",
              (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $2 AND g."dayOfAttendance" = 'ATTENDING'
                 AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $1 AND sa."guestId" = g.id)
              ) AS "unassigned"`,
      [planVersionId, weddingId]
    );
    const seated = countRows[0].seated as number;
    const unassigned = countRows[0].unassigned as number;
    const draftSuffix = makeCurrent
      ? madeCurrentBecauseNoCurrentPlan
        ? " (made Current, as there was no current plan)"
        : ""
      : " (saved as a comparison draft, not made Current)";
    const description =
      (seated > 0
        ? `Generated version ${versionNumber}: seated ${seated} guest(s)` +
          (unassigned > 0 ? `, ${unassigned} left unassigned.` : ".")
        : `Generated version ${versionNumber}: no guests could be seated.`) + draftSuffix;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description)
       VALUES ($1, $2, 'GENERATE', $3)`,
      [randomUUID(), planVersionId, description]
    );

    await client.query("COMMIT");
    return { planVersionId, savedAsDraftBecauseApproved, madeCurrentBecauseNoCurrentPlan };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23503") throw new PlanSourceChangedError();
    throw err;
  } finally {
    client.release();
  }
}

// FR-7.4: a locked guest's *current* table (from the Current Plan Version, whether or not it's
// the one about to be regenerated) is what a fresh generation tries to preserve. Reads the
// isCurrent flag (FR-5.6) rather than the highest versionNumber, so a Comparison Draft never
// gets treated as the source of truth for locks just because it happens to be newer.
export async function getLatestAssignmentsForWedding(
  weddingId: string
): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT sa."guestId", sa."seatingTableId" AS "tableId"
     FROM "seat_assignments" sa
     JOIN "plan_versions" pv ON pv.id = sa."planVersionId"
     WHERE pv."weddingId" = $1 AND pv."isCurrent"`,
    [weddingId]
  );
  return new Map(rows.map((r) => [r.guestId, r.tableId]));
}

// TS-165: a new attending guest has no seat yet, so the plan is no longer complete. Nothing
// recounted that on add, so a plan could be approved with the new guest unseated (and an approved
// plan kept saying it was complete). Recounts, and on an approved plan records it in the plan's
// history so it shows "Modified since approval".
export async function refreshPlanAfterGuestAdded(weddingId: string, guestName: string, actorUserId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-181: locked by "the current plan" (lockCurrentPlan re-reads isCurrent under the lock) --
    // before, the id was read first and locked after, so a Generate in between left the new
    // version uncounted and recorded the guest on the old one.
    const planVersionId = await lockCurrentPlan(client, weddingId);
    if (planVersionId) {
      // TS-189: the plan now has someone new to seat, so anyone holding it from before gets "this
      // plan changed" -- before, the revision stayed the same and an older copy could still act.
      await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: true });
      await recordRecheckIfApproved(client, planVersionId, `${guestName} was added to the guest list — not seated yet`, actorUserId);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// FR-2.9 ("removing the guest" trigger): recomputes the Current Plan Version's isComplete using
// the same combined unassigned+needsReassignment formula every other write path uses. A guest
// delete cascades away their seat_assignments row at the DB level (no invalid assignment can be
// left behind for *them*), but if they were counted as Unassigned, removing them can flip the
// plan from incomplete to complete -- nothing else recomputes that on delete today.
// TS-181: in one transaction under the current plan's lock (lockCurrentPlan), so a count taken
// just before a Generate or a seat change can't be written over the newer answer; and the plan is
// only written to -- its revision bumped -- when its completeness actually changes.
// TS-189: or when the list of guests waiting for a seat may have changed (an attending guest was
// removed: `unassignedMayHaveChanged`) -- the plan's unseated list is part of what a copy shows.
export async function recomputeCurrentPlanCompleteness(
  weddingId: string,
  { unassignedMayHaveChanged = false }: { unassignedMayHaveChanged?: boolean } = {}
): Promise<void> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const planVersionId = await lockCurrentPlan(client, weddingId);
    if (planVersionId) {
      const { rows: countRows } = await client.query(
        `SELECT pv."isComplete",
           (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
              AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id)
           ) AS "unassignedCount",
           (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
             AS "needsReassignmentCount"
         FROM "plan_versions" pv WHERE pv.id = $2`,
        [weddingId, planVersionId]
      );
      const counts = countRows[0] as { isComplete: boolean; unassignedCount: number; needsReassignmentCount: number };
      const isComplete = counts.unassignedCount === 0 && counts.needsReassignmentCount === 0;
      if (isComplete !== counts.isComplete || unassignedMayHaveChanged) {
        await client.query(`UPDATE "plan_versions" SET "isComplete" = $1, revision = revision + 1 WHERE id = $2`, [
          isComplete,
          planVersionId,
        ]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// TS-189: "seated" counts only guests who are attending -- an older version still holds the seats of
// guests who have since declined, and counting them made "seated" plus "unassigned" add up to more
// than the guests there are. And an older (not current) version's stored "complete" was worked out
// when it was last current, so it's worked out again here against today's guest list (the current
// plan's own is kept up to date by every change).
export async function listPlanVersionsForWedding(weddingId: string): Promise<PlanVersionRow[]> {
  const { rows } = await pool.query(
    `WITH attending AS (
       SELECT COUNT(*)::int AS n FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'
     ),
     seated AS (
       SELECT sa."planVersionId", COUNT(DISTINCT sa."guestId")::int AS count,
              bool_or(sa."needsReassignment") AS "anyFlagged"
       FROM "seat_assignments" sa
       JOIN "guests" g ON g.id = sa."guestId" AND g."dayOfAttendance" = 'ATTENDING'
       JOIN "plan_versions" p ON p.id = sa."planVersionId" AND p."weddingId" = $1
       GROUP BY sa."planVersionId"
     )
     SELECT pv.id, pv."weddingId", pv."versionNumber", pv.label, pv.status,
            CASE WHEN pv."isCurrent" THEN pv."isComplete"
                 ELSE COALESCE(sa.count, 0) >= attending.n AND NOT COALESCE(sa."anyFlagged", false)
            END AS "isComplete",
            pv."approvedAt", pv."createdAt", pv.revision, pv."isCurrent",
            COALESCE(sa.count, 0)::int AS "assignedGuestCount",
            GREATEST(attending.n - COALESCE(sa.count, 0)::int, 0) AS "unassignedGuestCount",
            restored_from."versionNumber" AS "restoredFromVersionNumber"
     FROM "plan_versions" pv
     CROSS JOIN attending
     LEFT JOIN seated sa ON sa."planVersionId" = pv.id
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
/** TS-172: one plan version's status, scoped to its wedding (null if there's no such version). */
export async function getPlanVersionStatusForWedding(id: string, weddingId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT status FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2`, [id, weddingId]);
  return (rows[0]?.status as string | undefined) ?? null;
}

export async function getCurrentPlanVersionStatus(weddingId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT status FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" LIMIT 1`,
    [weddingId]
  );
  return rows[0]?.status ?? null;
}

// FR-6.4: status can only ever change on the Current Plan Version — approving or reviewing an
// old, superseded version (or an as-yet-unpromoted Comparison Draft, FR-5.6) makes no sense and
// isn't allowed.
async function isCurrentVersion(id: string, weddingId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT "isCurrent" FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  if (!rows[0]) throw new PlanVersionNotFoundError();
  return rows[0].isCurrent;
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
  actorUserId: string,
  expectedRevision?: number,
  // TS-179: worked out by the route from who is asking. Checked here, under the plan row lock,
  // against the status the plan has right now -- the route's own earlier read could be stale if
  // someone approved (or un-approved) the plan in between. Omitted means "allowed" (internal use).
  permissions: {
    mayApprove?: boolean;
    mayLeaveApproved?: boolean;
    mayMoveDraftAndReview?: boolean;
    // TS-197: the person asking saw this plan approved (worked out by the route). Only then is a
    // Draft/In review request from someone who may only undo approvals answered "it isn't approved
    // any more" -- otherwise it's simply something they don't have permission to do.
    sawApproved?: boolean;
  } = {}
): Promise<PlanVersionDetail | null> {
  if (!(await isCurrentVersion(id, weddingId))) {
    throw new PlanVersionStatusError(
      "Only the current plan version's status can be changed — this one has been superseded."
    );
  }

  let previousStatus: PlanVersionStatusValue;
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows } = await client.query(
      // TS-187: NO KEY UPDATE -- see resyncSeatsAtTable in seat-checks.ts.
      `SELECT status, "isComplete", revision, "isCurrent" FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    previousStatus = current.status as PlanVersionStatusValue;
    // TS-189: a stale copy first -- before, the permission rules below were judged against a status
    // the person hadn't seen yet, so they could be told "you can't do that" about a change someone
    // else had just made, instead of being shown the plan as it now is.
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      await client.query("ROLLBACK").catch(() => {});
      // TS-197: read on this same connection (see checkPlanVersionRevision).
      const fresh = await getPlanVersionDetail(id, weddingId, client);
      throw new PlanVersionConflictError(
        "This plan changed since you loaded it (maybe in another tab, or by someone else). It's been refreshed with the latest — check it and make your change again if it's still needed.",
        fresh!
      );
    }
    // TS-165: re-checked under the lock (a Generate could have replaced this version a moment ago).
    if (!current.isCurrent) {
      throw new PlanVersionStatusError(
        "Only the current plan version's status can be changed — this one has been superseded."
      );
    }
    // TS-179: the permission rules, against the status as it is under the lock.
    if (newStatus === "APPROVED" && permissions.mayApprove === false) {
      throw new PlanApprovalPermissionError(
        "Only the wedding's owner, or a Couple member with Comment or Edit access, can approve a plan."
      );
    }
    if (current.status === "APPROVED" && newStatus !== "APPROVED" && permissions.mayLeaveApproved === false) {
      throw new PlanApprovalPermissionError(
        "This plan has just been approved. Only the wedding's owner, or a Couple member with Comment or Edit access, can undo an approval."
      );
    }
    if (current.status !== "APPROVED" && newStatus !== "APPROVED" && permissions.mayMoveDraftAndReview === false) {
      // TS-189: someone who can undo an approval but not otherwise move a plan between Draft and In
      // review (a Couple member with Comment access) only ever asks for this to undo an approval --
      // so the plan was approved when they looked, and someone has undone it since. Say so, and show
      // them the plan as it is now, rather than "you don't have permission".
      // TS-197: only when they really saw it approved -- a Couple member with Comment access asking
      // to move a plan they saw as a Draft (or In review) just isn't allowed to.
      if (permissions.mayLeaveApproved !== false && permissions.sawApproved === true) {
        await client.query("ROLLBACK").catch(() => {});
        const fresh = await getPlanVersionDetail(id, weddingId, client);
        throw new PlanVersionConflictError("This plan isn't approved any more — it's been refreshed.", fresh!);
      }
      throw new PlanApprovalPermissionError("You don't have permission to do that");
    }
    // TS-189: asking for the status it already has changes nothing -- answered before the
    // re-check below, so re-approving an approved plan doesn't re-check (and save flags on) it, or
    // refuse with "can't be approved yet".
    if (current.status === newStatus) {
      await client.query("ROLLBACK").catch(() => {});
      // TS-197: read on this same connection (see checkPlanVersionRevision).
      return getPlanVersionDetail(id, weddingId, client);
    }

    // TS-165: approval counts unseated and flagged guests now, under the lock, rather than trusting
    // the stored flag -- a guest added since the last recount used to slip through unseated.
    // TS-181: and re-checks every table the plan seats anyone at first, under the same lock --
    // before, approval trusted the stored Needs Reassignment flags, so a table edit or a new rule
    // whose own re-check didn't run (or failed after saving) could let a broken plan be approved.
    let recheckChanged = false;
    if (newStatus === "APPROVED") {
      const { rows: planTables } = await client.query(
        `SELECT DISTINCT "seatingTableId" AS "tableId" FROM "seat_assignments" WHERE "planVersionId" = $1`,
        [id]
      );
      recheckChanged = (await resyncTables(client, weddingId, id, planTables.map((r) => r.tableId as string))).changed;
      await refreshPlanCompleteness(client, weddingId, id, { bumpRevision: recheckChanged });
      if (recheckChanged) {
        await recordRecheckIfApproved(client, id, "Seating re-checked before approval — some guests' Needs Reassignment flags changed", actorUserId);
      }
      const { rows: recount } = await client.query(`SELECT "isComplete" FROM "plan_versions" WHERE id = $1`, [id]);
      // TS-197: the recount changed whether the plan is complete -- that's a change to the plan too,
      // so its revision moves on (unless the re-check above already moved it).
      if (!recheckChanged && recount[0].isComplete !== current.isComplete) {
        await client.query(`UPDATE "plan_versions" SET revision = revision + 1 WHERE id = $1`, [id]);
      }
      current.isComplete = recount[0].isComplete;
    }
    if (newStatus === "APPROVED" && !current.isComplete) {
      // TS-181: flags the re-check just corrected are kept, so the planner sees who to fix.
      // TS-189: committed in every case here (with nothing to keep it's an empty commit), so this
      // refusal always leaves the plan the same way.
      await client.query("COMMIT");
      // TS-197: the plan as it is now goes back with the refusal, so the screen shows who to fix
      // (and holds the new revision) without a second request.
      const fresh = await getPlanVersionDetail(id, weddingId, client);
      throw new PlanVersionStatusError(
        // TS-177: a plan is held back by flagged guests too, not just unseated ones.
        "This plan can't be approved yet — some guests aren't seated, or are flagged Needs Reassignment. Sort those out first.",
        fresh
      );
    }

    await client.query(
      `UPDATE "plan_versions"
       SET status = $1::"PlanVersionStatus",
           -- TS-181: the moment of approval itself (not when this transaction began), and after
           -- every change already in the plan's history -- see HISTORY_CREATED_AT.
           "approvedAt" = CASE WHEN $1::"PlanVersionStatus" = 'APPROVED'
             THEN GREATEST(clock_timestamp(), (SELECT MAX("createdAt") + interval '1 millisecond'
                                               FROM "change_history_entries" WHERE "planVersionId" = $2))
             ELSE NULL END,
           revision = revision + 1
       WHERE id = $2`,
      [newStatus, id]
    );

    // TS-189: in words (it read "from IN_REVIEW to APPROVED").
    const description = `Status changed from ${PLAN_STATUS_LABEL[previousStatus]} to ${PLAN_STATUS_LABEL[newStatus]}`;
    // TS-181: the approval's own entry is dated exactly at approvedAt, so it never counts as a
    // change made after approval; any other status change is dated when it's written.
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId", "createdAt")
       VALUES ($1, $2, 'STATUS_CHANGE', $3, $4, COALESCE((SELECT "approvedAt" FROM "plan_versions" WHERE id = $2), clock_timestamp()))`,
      [randomUUID(), id, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // FR-10.2: a status change to IN_REVIEW is "the plan is shared for review"; any other status
  // transition is notified as a plain status change.
  // TS-189: except an approval being undone back to In review -- that's not a plan being shared,
  // it's an approval taken back, and it says so.
  const reopened = previousStatus === "APPROVED" && newStatus === "IN_REVIEW";
  // TS-194: the change above is already saved -- telling people about it is best effort, so a
  // failure is logged and never turns the saved change into an error.
  try {
    await notifyWeddingCollaborators(
      weddingId,
      actorUserId,
      newStatus === "IN_REVIEW" && !reopened ? "PLAN_SHARED" : "STATUS_CHANGED",
      reopened
        ? "The seating plan's approval was undone — it's back in review."
        : newStatus === "IN_REVIEW"
          ? "The seating plan was shared for review."
          : // TS-177: in words, not the status codes (it read "changed to APPROVED").
            newStatus === "APPROVED"
            ? "The seating plan was approved."
            : "The seating plan was moved back to draft."
    );
  } catch (err) {
    console.error("Saved, but notifying the wedding's members failed:", err);
  }

  return getPlanVersionDetail(id, weddingId);
}

export async function getPlanVersionDetail(
  id: string,
  weddingId: string,
  // TS-197: a transaction's own connection may be passed, so a fresh copy is read on it.
  q: PlanReader = pool
): Promise<PlanVersionDetail | null> {
  const { rows: versionRows } = await q.query(
    `SELECT pv.id, pv."weddingId", pv."versionNumber", pv.label, pv.status, pv."isComplete",
            pv."approvedAt", pv."createdAt", pv."sideMixingSetting", pv."ruleConfigVersion", pv.revision,
            pv."isCurrent",
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
    // The approval's own change-history row is dated exactly at approvedAt, so a strict
    // "createdAt > approvedAt" excludes that STATUS_CHANGE entry itself and only finds genuine
    // edits made afterward. TS-181: those are dated when they're written (clock_timestamp(), and
    // never at or before approvedAt -- see HISTORY_CREATED_AT), so a change that waited for the
    // approval to finish is never dated before it.
    const { rows: modRows } = await q.query(
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

  // ORDER BY here is just a stable baseline -- sorting on t.label in SQL would group "Table 10"'s
  // guests ahead of "Table 2"'s (lexicographic, not numeric). The real table ordering is applied
  // below with the same numeric-aware comparator used everywhere else tables are listed, so a
  // plan's list view (which groups these assignments table by table) reads in the order a person
  // actually expects.
  const { rows: assignments } = await q.query(
    `SELECT sa.id, sa."guestId", (g."firstName" || ' ' || g."lastName") AS "guestName",
            sa."seatingTableId" AS "tableId", t.label AS "tableLabel", sa."needsReassignment"
     FROM "seat_assignments" sa
     JOIN "guests" g ON g.id = sa."guestId"
     JOIN "seating_tables" t ON t.id = sa."seatingTableId"
     WHERE sa."planVersionId" = $1
     ORDER BY t."createdAt", g."lastName", g."firstName"`,
    [id]
  );
  assignments.sort((a, b) => compareTableLabels(a.tableLabel, b.tableLabel));

  // FR-8.1: a guest marked Not Attending doesn't occupy a seat and isn't counted as
  // "unassigned" — they've been excluded from the plan entirely, not left pending.
  const { rows: allGuests } = await q.query(
    `SELECT id FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'`,
    [weddingId]
  );
  const assignedIds = new Set(assignments.map((a) => a.guestId));
  const unassignedGuestIds = allGuests.map((g) => g.id).filter((id) => !assignedIds.has(id));
  // TS-189: an older version's stored "complete" dates from when it was last current -- worked out
  // again against today's guest list (see listPlanVersionsForWedding).
  const attendingIds = new Set(allGuests.map((g) => g.id as string));
  const isComplete = version.isCurrent
    ? version.isComplete
    : unassignedGuestIds.length === 0 && !assignments.some((a) => a.needsReassignment && attendingIds.has(a.guestId));

  return {
    ...version,
    isComplete,
    // TS-197: only attending guests' seats -- an older version still holds seats of guests who have
    // since declined (the same count the version list gives).
    assignedGuestCount: assignments.filter((a) => attendingIds.has(a.guestId)).length,
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
  actorUserId: string,
  expectedRevision?: number
): Promise<ManualMoveResult> {
  if (!(await isCurrentVersion(planVersionId, weddingId))) {
    // TS-197: with the plan that is current now, so the screen can switch to it.
    throw new ManualMoveError(SUPERSEDED_EDIT_MESSAGE, await getCurrentPlanDetail(weddingId));
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
     WHERE t."weddingId" = $1 AND t."isRestricted"`,
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
  // TS-197: they declined between the first check and this read -- say so, rather than "moving"
  // nobody and calling it done.
  if (unit.length === 0) throw new ManualMoveError(`${guest.name} is marked Not Attending, so they can't be seated.`);
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

  // TS-189: the whole group is already at that table -- nothing to move. Answered before the
  // checks below (a table that's over its seats would otherwise refuse a "move" that changes
  // nothing), and checked again under the plan's lock before anything is written.
  if (unit.length > 0 && unit.every((member) => occupantRows.some((o) => o.guestId === member.id))) {
    const unchanged = await getPlanVersionDetail(planVersionId, weddingId);
    if (unchanged && (expectedRevision === undefined || unchanged.revision === expectedRevision)) {
      return { planVersion: { ...unchanged, warnings: [] }, warnings: [] };
    }
  }

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
  // FR-0.2 AC2: every such warning names the affected preference and references the applied
  // weighting-configuration version.
  const ruleConfigVersionForWarnings = await getEffectiveRuleConfigVersion(planVersionId);
  const warnings: string[] = [];
  for (const member of unit) {
    const avoids = avoidByGuest.get(member.id);
    if (!avoids) continue;
    for (const occupant of occupants) {
      if (avoids.has(occupant.guestId)) {
        warnings.push(
          `${member.name} and ${occupant.name} will be seated together at "${targetTable.label}" ` +
            `despite an "avoid" preference between them (weighting-configuration version ` +
            `${ruleConfigVersionForWarnings}).`
        );
      }
    }
  }

  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await checkPlanVersionRevision(client, planVersionId, weddingId, expectedRevision, (currentPlan) => new ManualMoveError(SUPERSEDED_EDIT_MESSAGE, currentPlan));
    // TS-165: the tables this move can affect, as things stand before it.
    const unitIds = unit.map((member) => member.id);
    // TS-169: attendance checked again inside the transaction -- a guest who declined by link a
    // moment ago (after the check above) isn't seated by a move that was already on its way.
    const { rows: absent } = await client.query(
      `SELECT ("firstName" || ' ' || "lastName") AS name FROM "guests"
       WHERE id = ANY($1::text[]) AND "dayOfAttendance" <> 'ATTENDING' FOR SHARE`,
      [unitIds]
    );
    if (absent[0]) throw new ManualMoveError(`${absent[0].name} is marked Not Attending, so they can't be seated.`);
    // TS-189: under the lock -- if the whole group is already there, nothing is written (no
    // revision bump, history line or notification for a move that moved nobody).
    const { rows: alreadyThere } = await client.query(
      `SELECT COUNT(*)::int AS n FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = ANY($2::text[]) AND "seatingTableId" = $3`,
      [planVersionId, unitIds, targetTableId]
    );
    if (alreadyThere[0].n === unitIds.length) {
      await client.query("ROLLBACK").catch(() => {});
      // TS-197: read on this same connection (see checkPlanVersionRevision).
      const unchanged = await getPlanVersionDetail(planVersionId, weddingId, client);
      if (!unchanged) throw new ManualMoveError("Plan version not found.");
      return { planVersion: { ...unchanged, warnings: [] }, warnings: [] };
    }
    const affectedBefore = await tablesAffectedBy(client, weddingId, planVersionId, unitIds);
    // TS-181: a guest moved to a different table is seated there now (SEAT_ORDER counts them last).
    for (const member of unit) {
      await client.query(
        `INSERT INTO "seat_assignments" (id, "planVersionId", "guestId", "seatingTableId", "needsReassignment", "updatedAt", "createdAt")
         VALUES ($1, $2, $3, $4, false, now(), clock_timestamp())
         ON CONFLICT ("planVersionId", "guestId")
         DO UPDATE SET "seatingTableId" = EXCLUDED."seatingTableId", "needsReassignment" = false, "updatedAt" = now(),
           "createdAt" = CASE WHEN "seat_assignments"."seatingTableId" = EXCLUDED."seatingTableId"
                              THEN "seat_assignments"."createdAt" ELSE EXCLUDED."createdAt" END`,
        [randomUUID(), planVersionId, member.id, targetTableId]
      );
    }
    // TS-153: the move's checks ran before this transaction, so two moves at once (or one sent
    // without expectedRevision) could both see room at the table. Re-checking it here, as it now
    // stands, flags anyone who doesn't fit instead of letting the table go over capacity.
    // TS-165: and the table they left, and their rule partners' tables -- so a flag that no longer
    // applies there (a must-not-sit-together pair now apart, a seat now free) is cleared.
    const affectedAfter = await tablesAffectedBy(client, weddingId, planVersionId, unitIds);
    await resyncTables(client, weddingId, planVersionId, [targetTableId, ...affectedBefore, ...affectedAfter]);

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
    await client.query(
      `UPDATE "plan_versions" SET "isComplete" = $1, revision = revision + 1 WHERE id = $2`,
      [isComplete, planVersionId]
    );

    const description = `Moved ${unit.map((g) => g.name).join(", ")} to "${targetTable.label}"`;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId", "createdAt")
       VALUES ($1, $2, 'MANUAL_MOVE', $3, $4, ${HISTORY_CREATED_AT})`,
      [randomUUID(), planVersionId, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) throw new ManualMoveError("Plan version not found after move.");
  // TS-197: the move's warnings come back once, as `warnings` -- they're no longer copied into the
  // plan's own list too (the Seating plan tab showed them twice).

  // FR-10.2: table changes are only notification-worthy once the plan has been approved (a Draft
  // is expected to be edited constantly and would otherwise spam everyone).
  if (planVersion.status === "APPROVED") {
    // TS-194: the change above is already saved -- telling people about it is best effort, so a
    // failure is logged and never turns the saved change into an error.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        actorUserId,
        "TABLE_CHANGED",
        `${unit.map((g) => g.name).join(", ")} moved to "${targetTable.label}".`
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
  }

  return { planVersion, warnings };
}

// Shared by moveGuestAssignment and unassignGuestFromPlan: everyone connected to this guest by a
// chain of MUST_SIT_TOGETHER rules always shares a table, so any manual action on "just" this
// guest really applies to the whole unit. Not-attending guests are excluded (FR-8.1).
async function findMustSitTogetherUnit(
  weddingId: string,
  guestId: string
): Promise<{ id: string; name: string }[]> {
  const { rows: allGuests } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name
     FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'`,
    [weddingId]
  );
  const { rows: rels } = await pool.query(
    `SELECT "guestAId", "guestBId" FROM "guest_relationships"
     WHERE "weddingId" = $1 AND type = 'MUST_SIT_TOGETHER'`,
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
    if (parent.has(r.guestAId) && parent.has(r.guestBId)) union(r.guestAId, r.guestBId);
  }
  const root = find(guestId);
  return allGuests.filter((g) => find(g.id) === root);
}

// FR-7.5: undo/redo needs a way to put a guest (and their must-sit-together unit) back to
// Unassigned when the action being undone was originally assigning a previously-unassigned
// guest to a table. Never exposed as a manual "unassign" control -- only the undo/redo stack
// calls this today -- but it's a real, independently useful primitive: unassigning never
// violates a hard rule (an empty seat can't conflict with anything), so there's nothing to block,
// only completeness and change history to keep in sync.
export async function unassignGuestFromPlan(
  planVersionId: string,
  weddingId: string,
  guestId: string,
  actorUserId: string,
  expectedRevision?: number
): Promise<ManualMoveResult> {
  if (!(await isCurrentVersion(planVersionId, weddingId))) {
    // TS-197: with the plan that is current now, so the screen can switch to it.
    throw new ManualMoveError(SUPERSEDED_EDIT_MESSAGE, await getCurrentPlanDetail(weddingId));
  }
  const { rows: guestRows } = await pool.query(
    `SELECT id FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [guestId, weddingId]
  );
  if (!guestRows[0]) throw new ManualMoveError("Guest not found.");

  const unit = await findMustSitTogetherUnit(weddingId, guestId);
  // TS-197: they're marked Not Attending (their seat was freed then) -- say so instead of an
  // "unassign" that did nothing and reported success.
  if (unit.length === 0) {
    throw new ManualMoveError("That guest is marked Not Attending, so they don't have a seat to take away.");
  }

  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await checkPlanVersionRevision(client, planVersionId, weddingId, expectedRevision, (currentPlan) => new ManualMoveError(SUPERSEDED_EDIT_MESSAGE, currentPlan));
    // TS-165: re-check the table(s) they leave, and their rule partners' tables.
    const affected = await tablesAffectedBy(client, weddingId, planVersionId, unit.map((member) => member.id));
    let seatsFreed = 0;
    for (const member of unit) {
      const { rowCount } = await client.query(
        `DELETE FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2`,
        [planVersionId, member.id]
      );
      seatsFreed += rowCount ?? 0;
    }
    // TS-189: nobody in the group had a seat -- nothing changed, so nothing is recorded (no revision
    // bump, history line or notification).
    if (seatsFreed === 0) {
      await client.query("ROLLBACK").catch(() => {});
      // TS-197: read on this same connection (see checkPlanVersionRevision).
      const unchanged = await getPlanVersionDetail(planVersionId, weddingId, client);
      if (!unchanged) throw new ManualMoveError("Plan version not found.");
      return { planVersion: { ...unchanged, warnings: [] }, warnings: [] };
    }
    await resyncTables(client, weddingId, planVersionId, affected);

    const { rows: unassignedCountRows } = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
            AND NOT EXISTS (
              SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id
            )
         ) AS "count",
         (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
           AS "needsReassignmentCount"`,
      [weddingId, planVersionId]
    );
    const isComplete =
      unassignedCountRows[0].count === 0 && unassignedCountRows[0].needsReassignmentCount === 0;
    await client.query(
      `UPDATE "plan_versions" SET "isComplete" = $1, revision = revision + 1 WHERE id = $2`,
      [isComplete, planVersionId]
    );

    const description = `Unassigned ${unit.map((g) => g.name).join(", ")}`;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId", "createdAt")
       VALUES ($1, $2, 'MANUAL_MOVE', $3, $4, ${HISTORY_CREATED_AT})`,
      [randomUUID(), planVersionId, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) throw new ManualMoveError("Plan version not found after unassign.");
  planVersion.warnings = [];

  if (planVersion.status === "APPROVED") {
    // TS-194: the change above is already saved -- telling people about it is best effort, so a
    // failure is logged and never turns the saved change into an error.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        actorUserId,
        "TABLE_CHANGED",
        `${unit.map((g) => g.name).join(", ")} unassigned from their table.`
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
  }

  return { planVersion, warnings: [] };
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
  // TS-167: null when the guest did it themselves (declining or re-confirming through their link).
  actorUserId: string | null,
  // TS-167: the RSVP route sends its own notification about the response, so it skips this one.
  { notify = true }: { notify?: boolean } = {}
): Promise<PlanVersionDetail | null> {
  const { rows: guestRows } = await pool.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, "dayOfAttendance"
     FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [guestId, weddingId]
  );
  const guest = guestRows[0];
  if (!guest) throw new AttendanceError("Guest not found.");

  const { rows: currentRows } = await pool.query(
    `SELECT id FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" LIMIT 1`,
    [weddingId]
  );
  let currentPlanVersionId: string | undefined = currentRows[0]?.id;

  if (guest.dayOfAttendance === attendance) {
    // Already at the requested attendance — no-op, just return current state.
    return currentPlanVersionId ? getPlanVersionDetail(currentPlanVersionId, weddingId) : null;
  }

  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-169: the same wedding lock Generate and Restore take, then the guest's row -- and the
    // current version and their attendance read again under them. Before, a guest declining by
    // link while a plan was being generated (or the planner moved them) could keep their seat.
    await client.query(`SELECT id FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`, [weddingId]);
    // TS-173: the current plan's row before the guest's (see lockCurrentPlan) -- a move locks the
    // plan first too, so the two can no longer deadlock.
    currentPlanVersionId = (await lockCurrentPlan(client, weddingId)) ?? undefined;
    // TS-188: a planner marking someone attending again is checked against their Restricted table's
    // list below -- so the lists' lock comes next, in the usual order (plan, lists, then rows).
    const plannerReturning = attendance === "ATTENDING" && actorUserId !== null;
    if (plannerReturning) await lockRestrictedLists(client, weddingId);
    const { rows: lockedGuest } = await client.query(
      `SELECT "dayOfAttendance" FROM "guests" WHERE id = $1 FOR NO KEY UPDATE`,
      [guestId]
    );
    // TS-174: removed in the meantime -- nothing to change (before, the history still said they were).
    if (!lockedGuest[0]) throw new AttendanceError("Guest not found.");
    if (lockedGuest[0].dayOfAttendance === attendance) {
      await client.query("COMMIT");
      return currentPlanVersionId ? getPlanVersionDetail(currentPlanVersionId, weddingId) : null;
    }
    // TS-174: the change itself is shared with a guest's own RSVP (submitGuestRsvp), which makes it
    // inside the same transaction as their answer.
    await applyAttendanceChange(client, weddingId, currentPlanVersionId ?? null, { id: guestId, name: guest.name }, attendance, actorUserId);
    // TS-188: Restricted lists count only attending guests, so someone coming back counts again --
    // the planner can't bring them back if their table's list would then need more seats than it
    // has (as with a bigger party). A guest's own RSVP is never refused (Tom's decision).
    if (plannerReturning) {
      const [over] = await restrictedListsOverCapacity(client, [guestId]);
      if (over) {
        throw new AttendanceError(
          `${guest.name} is on "${over.tableLabel}"'s required-guest list, which would then need ${over.seats} seats — it has ${over.capacity}. Give that table more seats, or take someone off its list first.`
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const detail = currentPlanVersionId ? await getPlanVersionDetail(currentPlanVersionId, weddingId) : null;

  // FR-10.2: attendance changes are only notification-worthy once the plan has been approved.
  if (notify && detail?.status === "APPROVED") {
    // TS-194: the change above is already saved -- telling people about it is best effort, so a
    // failure is logged and never turns the saved change into an error.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        actorUserId,
        "ATTENDANCE_CHANGED",
        attendance === "NOT_ATTENDING"
          ? `${guest.name} was marked not attending.`
          : `${guest.name} was marked attending again.`
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
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
  actorUserId: string,
  expectedRevision?: number
): Promise<ManualMoveResult> {
  if (!(await isCurrentVersion(planVersionId, weddingId))) {
    // TS-197: with the plan that is current now, so the screen can switch to it.
    throw new SwapError(SUPERSEDED_EDIT_MESSAGE, await getCurrentPlanDetail(weddingId));
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
  // TS-165: every member must have a seat -- dropping unseated ones let a half-seated group through,
  // and its capacity check then counted people who weren't at the table.
  const unitATables = new Set(unitA.map((g) => tableByGuest.get(g.id)));
  const unitBTables = new Set(unitB.map((g) => tableByGuest.get(g.id)));
  if (unitATables.size !== 1 || unitATables.has(undefined)) {
    throw new SwapError(
      `${guestA.name}'s group isn't fully seated at one table yet — seat them first before swapping.`
    );
  }
  if (unitBTables.size !== 1 || unitBTables.has(undefined)) {
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
  // FR-0.2 AC2: every such warning names the affected preference and references the applied
  // weighting-configuration version.
  const ruleConfigVersionForWarnings = await getEffectiveRuleConfigVersion(planVersionId);
  const warnings: string[] = [];
  for (const member of unitB) {
    const avoids = avoidByGuest.get(member.id);
    if (!avoids) continue;
    for (const occupant of stayingAtA) {
      if (avoids.has(occupant.guestId)) {
        warnings.push(
          `${member.name} and ${occupant.name} will be seated together at "${tableA.label}" ` +
            `despite an "avoid" preference between them (weighting-configuration version ` +
            `${ruleConfigVersionForWarnings}).`
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
            `despite an "avoid" preference between them (weighting-configuration version ` +
            `${ruleConfigVersionForWarnings}).`
        );
      }
    }
  }

  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await checkPlanVersionRevision(client, planVersionId, weddingId, expectedRevision, (currentPlan) => new SwapError(SUPERSEDED_EDIT_MESSAGE, currentPlan));
    // TS-181: each group is seated at its new table now (see SEAT_ORDER).
    for (const member of unitB) {
      await client.query(
        `UPDATE "seat_assignments" SET "seatingTableId" = $1, "needsReassignment" = false, "updatedAt" = now(), "createdAt" = clock_timestamp()
         WHERE "planVersionId" = $2 AND "guestId" = $3`,
        [tableAId, planVersionId, member.id]
      );
    }
    for (const member of unitA) {
      await client.query(
        `UPDATE "seat_assignments" SET "seatingTableId" = $1, "needsReassignment" = false, "updatedAt" = now(), "createdAt" = clock_timestamp()
         WHERE "planVersionId" = $2 AND "guestId" = $3`,
        [tableBId, planVersionId, member.id]
      );
    }

    // TS-150: re-check both tables as they now stand and recompute completeness -- a swap that
    // seats the last flagged guests makes the plan complete (so it can be approved), and anything
    // the swap breaks is flagged rather than hidden.
    // TS-165: plus the tables the two groups' rule partners sit at.
    const partnersTables = await tablesAffectedBy(client, weddingId, planVersionId, [...unitAIds, ...unitBIds]);
    await resyncTables(client, weddingId, planVersionId, [tableAId, tableBId, ...partnersTables]);
    await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: true });

    const description =
      `Swapped ${unitA.map((g) => g.name).join(", ")} (was at "${tableA.label}") with ` +
      `${unitB.map((g) => g.name).join(", ")} (was at "${tableB.label}")`;
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId", "createdAt")
       VALUES ($1, $2, 'MANUAL_SWAP', $3, $4, ${HISTORY_CREATED_AT})`,
      [randomUUID(), planVersionId, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) throw new SwapError("Plan version not found after swap.");
  // TS-197: the warnings come back once, as `warnings` (see moveGuestAssignment).

  // FR-10.2: same "only once approved" gating as a plain move.
  if (planVersion.status === "APPROVED") {
    // TS-194: the change above is already saved -- telling people about it is best effort, so a
    // failure is logged and never turns the saved change into an error.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        actorUserId,
        "TABLE_CHANGED",
        `Swapped ${unitA.map((g) => g.name).join(", ")} with ${unitB.map((g) => g.name).join(", ")}.`
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
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
// TS-173: reads through `q` -- a restore passes its own transaction's client, after taking the
// wedding lock, so attendance can't change between working out the seats and saving them.
async function computeRestorePlacement(sourceVersionId: string, weddingId: string, q: Pick<typeof pool, "query"> = pool) {
  const { rows: sourceRows } = await q.query(
    `SELECT id, "versionNumber" FROM "plan_versions" WHERE id = $1 AND "weddingId" = $2`,
    [sourceVersionId, weddingId]
  );
  const source = sourceRows[0];
  if (!source) throw new RestoreError("Source plan version not found.");

  const { rows: sourceAssignments } = await q.query(
    // TS-173: in the same order a table re-check uses (locked guests first, then in the order they
    // were seated), so the preview and the restore keep and drop the same guests.
    // TS-181: the very same SEAT_ORDER, with a fixed tie-break (it was the seat's random id).
    `SELECT sa."guestId", sa."seatingTableId" AS "tableId"
     FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId"
     WHERE sa."planVersionId" = $1
     ORDER BY ${SEAT_ORDER}`,
    [sourceVersionId]
  );

  const { rows: guests } = await q.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable"
     FROM "guests" WHERE "weddingId" = $1 AND "dayOfAttendance" = 'ATTENDING'`,
    [weddingId]
  );
  const guestsById = new Map(guests.map((g) => [g.id, g]));

  const { rows: tables } = await q.query(
    `SELECT id, label, capacity, "isAccessible", "isRestricted" FROM "seating_tables" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const tablesById = new Map(tables.map((t) => [t.id, t]));
  // TS-150: a Restricted table takes only the guests on its required list, and a guest on a list
  // belongs at that table and no other.
  const { rows: requiredRows } = await q.query(
    `SELECT rtg."tableId", rtg."guestId" FROM "restricted_table_guests" rtg
     JOIN "seating_tables" st ON st.id = rtg."tableId" WHERE st."weddingId" = $1 AND st."isRestricted"`,
    [weddingId]
  );
  const requiredTableByGuest = new Map(requiredRows.map((r) => [r.guestId as string, r.tableId as string]));

  const { rows: rels } = await q.query(
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
    if (table.isRestricted && requiredTableByGuest.get(guest.id) !== table.id) {
      droppedGuests.push({
        guestId: guest.id,
        guestName: guest.name,
        reason: `"${table.label}" is now a Restricted table and they aren't on its list`,
      });
      continue;
    }
    const requiredTableId = requiredTableByGuest.get(guest.id);
    if (requiredTableId && requiredTableId !== table.id) {
      droppedGuests.push({
        guestId: guest.id,
        guestName: guest.name,
        reason: `they're now required at "${tablesById.get(requiredTableId)?.label ?? "another table"}"`,
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
  // TS-177: guests kept at a table who'll be flagged Needs Reassignment once restored (the real
  // restore re-checks every table -- see checkNewVersion -- and a must-sit-together pair kept at
  // different tables fails that check).
  const needsFixing = new Set<string>();
  for (const [guestId, others] of mustTogetherByGuest) {
    if (!keptIds.has(guestId)) continue;
    for (const otherId of others) {
      if (!keptIds.has(otherId)) continue;
      const pairKey = [guestId, otherId].sort().join("|");
      if (warnedPairs.has(pairKey)) continue;
      if (tableByKeptGuest.get(guestId) !== tableByKeptGuest.get(otherId)) {
        warnedPairs.add(pairKey);
        needsFixing.add(guestId);
        needsFixing.add(otherId);
        const a = guestsById.get(guestId);
        const b = guestsById.get(otherId);
        warnings.push(
          `${a?.name ?? guestId} and ${b?.name ?? otherId} are now required to sit together, but ` +
            `this restored version keeps them at different tables (that rule didn't exist when ` +
            `this version was made) — they'll be flagged Needs Reassignment until one of them is moved.`
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
    // TS-177: complete only if the restored version will be -- nobody unseated, and nobody kept
    // somewhere the re-check will flag. Before, the preview could say "complete" when it wasn't.
    isComplete: unassignedGuestIds.length === 0 && needsFixing.size === 0,
    needsFixingCount: needsFixing.size,
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
    needsFixingCount: result.needsFixingCount,
    warnings: result.warnings,
  };
}

// FR-9.4: actually perform the restore — creates a new, numbered version (the source and every
// version/history entry in between are never touched) which becomes Current -- explicitly now
// (FR-5.6 means "newest version" and "Current" are no longer the same thing), the same way a
// plain "make current" generation does: unset whatever was Current first, in the same
// transaction, before the new row is inserted.
export async function restorePlanVersion(
  sourceVersionId: string,
  weddingId: string,
  actorUserId: string,
  // TS-179: false when the person restoring can't undo an approval -- an approved current plan is
  // then left current and the restored version is saved as a comparison draft beside it.
  options: { mayReplaceApproved?: boolean } = {}
): Promise<ManualMoveResult & { savedAsDraftBecauseApproved: boolean }> {
  const client = await pool.connect();
  let newVersionId: string;
  let savedAsDraftBecauseApproved = false;
  let result: Awaited<ReturnType<typeof computeRestorePlacement>>;
  try {
    await beginTransaction(client);
    // TS-150: one new version at a time per wedding -- two Generate (or Restore) clicks at once
    // would otherwise both take the same next version number and the second would fail.
    await client.query(`SELECT id FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`, [weddingId]);
    // TS-187: then the current plan's row, in the usual order (see lockCurrentPlan).
    const currentPlanId = await lockCurrentPlan(client, weddingId);
    // TS-173: worked out under the wedding lock (attendance changes take it too), so a guest who
    // declined a moment ago is never seated by the restore.
    result = await computeRestorePlacement(sourceVersionId, weddingId, client);

    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX("versionNumber"), 0) + 1 AS "next" FROM "plan_versions" WHERE "weddingId" = $1`,
      [weddingId]
    );
    const versionNumber: number = versionRows[0].next;

    // TS-179: checked under the wedding lock taken above, so an approval that lands a moment
    // before this restore is still respected.
    savedAsDraftBecauseApproved =
      options.mayReplaceApproved === false && (await currentPlanIsApproved(client, currentPlanId));
    const makeCurrent = !savedAsDraftBecauseApproved;

    // TS-189: the replaced version's revision is bumped too (see createPlanVersionWithAssignments).
    if (makeCurrent) {
      await client.query(
        `UPDATE "plan_versions" SET "isCurrent" = false, revision = revision + 1 WHERE "weddingId" = $1 AND "isCurrent"`,
        [weddingId]
      );
    }

    newVersionId = randomUUID();
    await client.query(
      `INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", status, "isComplete", "restoredFromId", "isCurrent")
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6)`,
      [newVersionId, weddingId, versionNumber, result.isComplete, sourceVersionId, makeCurrent]
    );

    await insertSeats(client, newVersionId, result.kept);

    // TS-150: check the restored seating against today's rules table by table (e.g. a must-sit
    // pair the old version kept apart), so the new version's completeness tells the truth.
    await checkNewVersion(client, weddingId, newVersionId);

    const description =
      `Restored from version ${result.sourceVersionNumber}` +
      (result.droppedGuests.length > 0
        ? ` (${result.droppedGuests.length} guest(s) left Unassigned — data has changed since then)`
        : "") +
      (savedAsDraftBecauseApproved ? " (saved as a comparison draft — the approved plan stays current)" : "");
    await client.query(
      `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId")
       VALUES ($1, $2, 'RESTORE', $3, $4)`,
      [randomUUID(), newVersionId, description, actorUserId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23503") throw new PlanSourceChangedError();
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
  return { planVersion, warnings, savedAsDraftBecauseApproved };
}

// TS-10/TS-12: give a plan version a free-text nickname so it's easier to tell apart than just
// its version number. An empty/blank string clears the label back to none. Any version can be
// labeled, not just the Current one — labels are just a memory aid, not part of the review
// workflow, so there's no "current version only" restriction like setPlanVersionStatus has.
export async function setPlanVersionLabel(
  id: string,
  weddingId: string,
  label: string,
  expectedRevision?: number
): Promise<PlanVersionDetail | null> {
  const trimmed = label.trim();
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await checkPlanVersionRevision(client, id, weddingId, expectedRevision);
    const { rows } = await client.query(
      `UPDATE "plan_versions" SET label = $1, revision = revision + 1 WHERE id = $2 AND "weddingId" = $3 RETURNING id`,
      [trimmed.length > 0 ? trimmed : null, id, weddingId]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getPlanVersionDetail(id, weddingId);
}

export interface GuestComparisonEntry {
  guestId: string;
  guestName: string;
  fromTableId: string | null;
  fromTableLabel: string | null;
  toTableId: string | null;
  toTableLabel: string | null;
  status: "unchanged" | "moved" | "added" | "removed";
}

export interface PlanVersionComparisonRef {
  id: string;
  versionNumber: number;
  label: string | null;
  createdAt: Date;
}

export interface PlanVersionComparison {
  from: PlanVersionComparisonRef;
  to: PlanVersionComparisonRef;
  guests: GuestComparisonEntry[];
  summary: { movedCount: number; addedCount: number; removedCount: number; unchangedCount: number };
}

export class CompareVersionError extends Error {}

// TS-10/TS-12: side-by-side comparison of two of a wedding's plan versions, guest by guest.
// Either version may be the older or newer one — the caller picks "from"/"to" and this just
// reports the diff in that direction. A guest seated in only one of the two versions (e.g.
// their attendance changed between versions, or they didn't exist yet) is "added"/"removed"
// rather than "moved", since there's no real "from" or "to" table to compare.
export async function comparePlanVersions(
  weddingId: string,
  fromId: string,
  toId: string
): Promise<PlanVersionComparison> {
  if (fromId === toId) {
    throw new CompareVersionError("Choose two different plan versions to compare.");
  }

  const { rows: versionRows } = await pool.query(
    `SELECT id, "versionNumber", label, "createdAt" FROM "plan_versions" WHERE "weddingId" = $1 AND id = ANY($2::text[])`,
    [weddingId, [fromId, toId]]
  );
  const byId = new Map(versionRows.map((r) => [r.id as string, r]));
  const from = byId.get(fromId);
  const to = byId.get(toId);
  if (!from || !to) {
    throw new CompareVersionError("One or both plan versions were not found for this wedding.");
  }

  const { rows: assignmentRows } = await pool.query(
    `SELECT sa."planVersionId", sa."guestId", (g."firstName" || ' ' || g."lastName") AS "guestName",
            sa."seatingTableId" AS "tableId", t.label AS "tableLabel"
     FROM "seat_assignments" sa
     JOIN "guests" g ON g.id = sa."guestId"
     JOIN "seating_tables" t ON t.id = sa."seatingTableId"
     WHERE sa."planVersionId" = ANY($1::text[])`,
    [[fromId, toId]]
  );

  const fromByGuest = new Map<string, { name: string; tableId: string; tableLabel: string }>();
  const toByGuest = new Map<string, { name: string; tableId: string; tableLabel: string }>();
  for (const row of assignmentRows) {
    const target = row.planVersionId === fromId ? fromByGuest : toByGuest;
    target.set(row.guestId, { name: row.guestName, tableId: row.tableId, tableLabel: row.tableLabel });
  }

  const allGuestIds = new Set([...fromByGuest.keys(), ...toByGuest.keys()]);
  const guests: GuestComparisonEntry[] = [];
  let movedCount = 0;
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  for (const guestId of allGuestIds) {
    const f = fromByGuest.get(guestId);
    const t = toByGuest.get(guestId);
    const guestName = (t ?? f)!.name;

    let status: GuestComparisonEntry["status"];
    if (f && t) {
      status = f.tableId === t.tableId ? "unchanged" : "moved";
    } else if (t && !f) {
      status = "added";
    } else {
      status = "removed";
    }
    if (status === "unchanged") unchangedCount++;
    else if (status === "moved") movedCount++;
    else if (status === "added") addedCount++;
    else removedCount++;

    guests.push({
      guestId,
      guestName,
      fromTableId: f?.tableId ?? null,
      fromTableLabel: f?.tableLabel ?? null,
      toTableId: t?.tableId ?? null,
      toTableLabel: t?.tableLabel ?? null,
      status,
    });
  }

  guests.sort((a, b) => a.guestName.localeCompare(b.guestName));

  return {
    from,
    to,
    guests,
    summary: { movedCount, addedCount, removedCount, unchangedCount },
  };
}
