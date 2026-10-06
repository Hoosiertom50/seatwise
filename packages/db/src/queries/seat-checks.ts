import { randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";

// TS-150: every check of "does the Current Plan Version still keep the hard rules?" lives here, in
// one place, so the guest edit, the guest import, a new or removed seating rule and a table edit
// all flag (and un-flag) Needs Reassignment the same way. Before, the guest-level re-check looked
// only at accessible / restricted / must-not rules and *wrote* its answer -- so editing a guest who
// was flagged because their table was over capacity cleared that flag, and the plan could be
// approved with too many people at a table.

// A minimal "Queryable" so a check can run against the shared pool or inside an already-open
// transaction's client (a bulk import, so the check is part of the same all-or-nothing write).
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

// Re-checks one already-seated guest's current table against every hard rule that's about the
// guest rather than the table's size: requires-accessible-table (FR-3.x), a Restricted table's
// required-guest list (FR-3.7a), must-not-sit-together (FR-3.1) against whoever else is at that
// table, and (TS-150) must-sit-together against a partner seated at a different table. Capacity
// is checked by resyncSeatsAtTable, which sees the whole table.
export async function checkGuestHardRuleViolation(
  q: Queryable,
  weddingId: string,
  planVersionId: string,
  guestId: string,
  tableId: string,
  requiresAccessibleTable: boolean
): Promise<boolean> {
  const { rows: tableRows } = await q.query(
    `SELECT "isAccessible", "isRestricted" FROM "seating_tables" WHERE id = $1`,
    [tableId]
  );
  const table = tableRows[0] as { isAccessible: boolean; isRestricted: boolean } | undefined;
  if (!table) return false;

  if (requiresAccessibleTable && !table.isAccessible) return true;

  if (table.isRestricted) {
    const { rows: reqRows } = await q.query(
      `SELECT 1 FROM "restricted_table_guests" WHERE "tableId" = $1 AND "guestId" = $2`,
      [tableId, guestId]
    );
    if (reqRows.length === 0) return true;
  }
  // TS-173: and the other way round -- a guest on a Restricted table's list belongs at that table
  // and no other. Before, only an unlisted guest *at* a Restricted table was flagged, so putting a
  // seated guest on another table's list left them where they were, unflagged.
  const { rows: requiredElsewhere } = await q.query(
    `SELECT 1 FROM "restricted_table_guests" rtg JOIN "seating_tables" t ON t.id = rtg."tableId"
     WHERE rtg."guestId" = $1 AND rtg."tableId" <> $2 AND t."isRestricted" LIMIT 1`,
    [guestId, tableId]
  );
  if (requiredElsewhere.length > 0) return true;

  const { rows: conflictRows } = await q.query(
    `SELECT 1
     FROM "guest_relationships" gr
     JOIN "seat_assignments" sa2
       ON sa2."planVersionId" = $1 AND sa2."guestId" <> $3
       AND ((gr."guestAId" = $3 AND gr."guestBId" = sa2."guestId")
         OR (gr."guestBId" = $3 AND gr."guestAId" = sa2."guestId"))
     WHERE gr."weddingId" = $4
       AND ((gr.type = 'MUST_NOT_SIT_TOGETHER' AND sa2."seatingTableId" = $2)
         OR (gr.type = 'MUST_SIT_TOGETHER' AND sa2."seatingTableId" <> $2))
     LIMIT 1`,
    [planVersionId, tableId, guestId, weddingId]
  );
  return conflictRows.length > 0;
}

// TS-181: when a plan-history entry happened, for "Modified since approval". A change's own
// transaction may have started before the plan was approved and only got its turn (the plan's
// lock) after the approval committed -- the default, now(), is when the transaction started, so
// that change was dated before the approval and never showed. clock_timestamp() is the moment the
// entry is written; and never earlier than just after the plan's approval (the column keeps only
// milliseconds, so a change in the same millisecond would otherwise tie with it). Use it as the
// "createdAt" value of an INSERT whose $2 is the plan version's id.
export const HISTORY_CREATED_AT = `GREATEST(clock_timestamp(), (SELECT "approvedAt" + interval '1 millisecond' FROM "plan_versions" WHERE id = $2))`;

export type TableSeatingFlagReason = "accessible" | "capacity" | "restricted" | "rule";

// A guest a re-check has just flagged Needs Reassignment, and why. TS-177: with the table they're
// seated at, so a message can tell "this table" (the one being edited) from the guest's own table
// elsewhere -- a required-guest list change re-checks other tables too.
export interface NewlyFlaggedSeat {
  guestId: string;
  name: string;
  reason: TableSeatingFlagReason;
  tableId: string;
}

// TS-181: the order seats at a table are counted in, so who gets flagged when there isn't room is
// always the same and makes sense: locked guests first, then in the order they were seated there,
// and guests seated at the same moment (a whole plan is saved at once) by name. Before, the
// tie-break was the seat's random id, so the same plan could flag a different guest each time.
// Shared by the table re-check and the restore preview (which must keep and drop the same guests).
// Uses the aliases sa (seat_assignments) and g (guests).
export const SEAT_ORDER = `g."isLocked" DESC, sa."createdAt", g."lastName", g."firstName", g.id`;

// FR-4.6 / TS-120 / TS-150: re-checks everyone seated at one table in the given plan version and
// sets Needs Reassignment exactly where a hard rule is broken or the table has no room left for
// them -- flagging and clearing alike, so the answer is always the whole truth for that table.
// Nobody is ever unseated. Who "no longer fits": locked guests keep their place first, then guests
// in the order they were seated (SEAT_ORDER); whoever pushes the headcount past capacity is flagged. Runs on
// the caller's client; the caller owns the transaction and recomputes isComplete.
export async function resyncSeatsAtTable(
  client: Queryable,
  weddingId: string,
  planVersionId: string,
  tableId: string
): Promise<{ newlyFlagged: NewlyFlaggedSeat[]; changed: boolean }> {
  // TS-187: NO KEY UPDATE (here and wherever a row's id isn't being changed or deleted) still lets
  // only one change at a time touch the row, but doesn't stop Postgres's own "does this table
  // still exist?" check when someone else saves a seat at it -- so the two don't wait on each other.
  const { rows: tableRows } = await client.query(
    `SELECT capacity, "isRestricted", "isAccessible" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
    [tableId, weddingId]
  );
  const table = tableRows[0] as { capacity: number; isRestricted: boolean; isAccessible: boolean } | undefined;
  if (!table) return { newlyFlagged: [], changed: false };
  const { rows: requiredRows } = await client.query(
    `SELECT "guestId" FROM "restricted_table_guests" WHERE "tableId" = $1`,
    [tableId]
  );
  const required = new Set(requiredRows.map((r) => r.guestId as string));

  const { rows } = await client.query(
    `SELECT sa.id, sa."guestId", (g."firstName" || ' ' || g."lastName") AS name, g.headcount,
            g."requiresAccessibleTable", sa."needsReassignment"
     FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId"
     WHERE sa."planVersionId" = $1 AND sa."seatingTableId" = $2
     ORDER BY ${SEAT_ORDER}
     FOR NO KEY UPDATE OF sa`,
    [planVersionId, tableId]
  );
  const seated = rows as {
    id: string;
    guestId: string;
    name: string;
    headcount: number;
    requiresAccessibleTable: boolean;
    needsReassignment: boolean;
  }[];

  const newlyFlagged: NewlyFlaggedSeat[] = [];
  let changed = false;
  let seatsUsed = 0;
  for (const a of seated) {
    const ruleBroken = await checkGuestHardRuleViolation(
      client,
      weddingId,
      planVersionId,
      a.guestId,
      tableId,
      a.requiresAccessibleTable
    );
    // A guest already flagged for a broken rule doesn't take up one of the table's seats.
    const fits = ruleBroken ? true : seatsUsed + a.headcount <= table.capacity;
    if (!ruleBroken && fits) seatsUsed += a.headcount;
    const flag = ruleBroken || !fits;
    if (flag !== a.needsReassignment) {
      changed = true;
      await client.query(
        `UPDATE "seat_assignments" SET "needsReassignment" = $1, "updatedAt" = now() WHERE id = $2`,
        [flag, a.id]
      );
      if (flag) {
        const reason: TableSeatingFlagReason = !fits
          ? "capacity"
          : a.requiresAccessibleTable && !table.isAccessible
            ? "accessible"
            : table.isRestricted && !required.has(a.guestId)
              ? "restricted"
              : "rule";
        newlyFlagged.push({ guestId: a.guestId, name: a.name, reason, tableId });
      }
    }
  }
  return { newlyFlagged, changed };
}

// TS-181: the Restricted tables any of these guests is on the required-guest list of, where the
// list as it now stands needs more seats than the table has -- for a change that grows a listed
// guest's party (the planner's edit, an import), checked after writing it on the same
// transaction so the caller can refuse it. Locks those tables' rows (guests before tables, as
// everywhere), so a list saved at the same moment is counted too.
export async function restrictedListsOverCapacity(
  q: Queryable,
  guestIds: string[]
): Promise<{ tableLabel: string; capacity: number; seats: number; guestNames: string[] }[]> {
  if (guestIds.length === 0) return [];
  const { rows: tables } = await q.query(
    `SELECT t.id, t.label, t.capacity FROM "seating_tables" t
     WHERE t."isRestricted" AND t.id IN (SELECT "tableId" FROM "restricted_table_guests" WHERE "guestId" = ANY($1::text[]))
     ORDER BY t.id FOR NO KEY UPDATE`,
    [guestIds]
  );
  const over: { tableLabel: string; capacity: number; seats: number; guestNames: string[] }[] = [];
  for (const t of tables as { id: string; label: string; capacity: number }[]) {
    // TS-188: only guests who are Attending need a seat; someone marked Not Attending doesn't count.
    const { rows } = await q.query(
      `SELECT COALESCE(SUM(g.headcount) FILTER (WHERE g."dayOfAttendance" = 'ATTENDING'), 0)::int AS seats,
              array_agg(g."firstName" || ' ' || g."lastName" ORDER BY g."lastName", g."firstName")
                FILTER (WHERE g.id = ANY($2::text[])) AS "guestNames"
       FROM "restricted_table_guests" rtg JOIN "guests" g ON g.id = rtg."guestId"
       WHERE rtg."tableId" = $1`,
      [t.id, guestIds]
    );
    const seats = rows[0].seats as number;
    if (seats > t.capacity) {
      over.push({ tableLabel: t.label, capacity: t.capacity, seats, guestNames: (rows[0].guestNames as string[] | null) ?? [] });
    }
  }
  return over;
}

// TS-188: which of these guests is on the required-guest list of a Restricted table that isn't
// accessible -- for a change that marks them as needing an accessible table (the planner's edit,
// an import), checked on the same transaction so the caller can refuse it. Share-locks those
// tables' rows (guests before tables, as everywhere), so switching a table's Accessible flag off
// at the same moment waits for this change and then sees it.
export async function requiredAtNonAccessibleTable(
  q: Queryable,
  guestIds: string[]
): Promise<{ guestName: string; tableLabel: string }[]> {
  if (guestIds.length === 0) return [];
  const { rows } = await q.query(
    `SELECT (g."firstName" || ' ' || g."lastName") AS "guestName", t.label AS "tableLabel"
     FROM "restricted_table_guests" rtg
     JOIN "seating_tables" t ON t.id = rtg."tableId"
     JOIN "guests" g ON g.id = rtg."guestId"
     WHERE rtg."guestId" = ANY($1::text[]) AND t."isRestricted" AND NOT t."isAccessible"
     ORDER BY t.id, g."lastName", g."firstName"
     FOR SHARE OF t`,
    [guestIds]
  );
  return rows as { guestName: string; tableLabel: string }[];
}

// TS-165: every table a change to these guests' seats can affect -- the tables they're at now,
// and the tables their seating-rule partners are at (a must-sit-together partner left behind, or a
// must-not-sit-together pair that's now apart). Call it before the change and again after, and
// re-check both sets: before, a guest who moved, left or was removed only had their new table (if
// any) re-checked, so flags at the table they left -- on someone else -- went stale.
export async function tablesAffectedBy(
  q: Queryable,
  weddingId: string,
  planVersionId: string,
  guestIds: string[]
): Promise<string[]> {
  if (guestIds.length === 0) return [];
  const { rows } = await q.query(
    `SELECT DISTINCT sa."seatingTableId" AS "tableId"
     FROM "seat_assignments" sa
     WHERE sa."planVersionId" = $1
       AND (sa."guestId" = ANY($2::text[])
         OR sa."guestId" IN (
           SELECT CASE WHEN gr."guestAId" = ANY($2::text[]) THEN gr."guestBId" ELSE gr."guestAId" END
           FROM "guest_relationships" gr
           WHERE gr."weddingId" = $3 AND (gr."guestAId" = ANY($2::text[]) OR gr."guestBId" = ANY($2::text[]))
         ))`,
    [planVersionId, guestIds, weddingId]
  );
  return rows.map((r) => r.tableId as string);
}

// TS-165: re-checks each of these tables (each once, in a fixed order so two requests lock them
// the same way round). The caller owns the transaction and refreshes completeness afterwards.
export async function resyncTables(
  client: Queryable,
  weddingId: string,
  planVersionId: string,
  tableIds: Iterable<string>
): Promise<{ newlyFlagged: NewlyFlaggedSeat[]; changed: boolean }> {
  const newlyFlagged: NewlyFlaggedSeat[] = [];
  let changed = false;
  for (const tableId of [...new Set(tableIds)].sort()) {
    const result = await resyncSeatsAtTable(client, weddingId, planVersionId, tableId);
    newlyFlagged.push(...result.newlyFlagged);
    changed ||= result.changed;
  }
  return { newlyFlagged, changed };
}

// TS-165: when a re-check changes who's flagged on an *approved* plan (a guest's RSVP grew their
// party, a table edit), it's recorded in the plan's history, so the plan shows "Modified since
// approval" -- before, an approved plan could quietly become incomplete with no sign of it.
export async function recordRecheckIfApproved(
  client: Queryable,
  planVersionId: string,
  description: string,
  actorUserId: string | null
): Promise<void> {
  const { rows } = await client.query(`SELECT status FROM "plan_versions" WHERE id = $1`, [planVersionId]);
  if (rows[0]?.status !== "APPROVED") return;
  await client.query(
    `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId", "createdAt")
     VALUES ($1, $2, 'SEATING_RECHECK', $3, $4, ${HISTORY_CREATED_AT})`,
    [randomUUID(), planVersionId, description, actorUserId]
  );
}

// TS-150: after flags change, keep the plan's completeness in step -- and bump its revision, so
// anyone holding the plan from before gets a conflict instead of acting on a stale picture.
export async function refreshPlanCompleteness(
  client: Queryable,
  weddingId: string,
  planVersionId: string,
  { bumpRevision }: { bumpRevision: boolean }
): Promise<void> {
  const { rows: countRows } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
          AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id)
       ) AS "unassignedCount",
       (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
         AS "needsReassignmentCount"`,
    [weddingId, planVersionId]
  );
  const counts = countRows[0] as { unassignedCount: number; needsReassignmentCount: number };
  const isComplete = counts.unassignedCount === 0 && counts.needsReassignmentCount === 0;
  await client.query(
    `UPDATE "plan_versions" SET "isComplete" = $1${bumpRevision ? `, revision = revision + 1` : ""} WHERE id = $2`,
    [isComplete, planVersionId]
  );
}

// TS-173: every write that touches seats takes its locks in one order -- the wedding row (when it
// needs one), then the current plan's row, then guests, tables and seats. Before, moves locked the
// plan first and re-checks locked tables or guests first, so a guest declining by link while the
// planner moved someone into their table could deadlock (and fail with a 500). Call this right
// after BEGIN (and after any wedding lock); it returns the current plan's id, if there is one.
// TS-187: when a Generate (or Restore) replaces the current plan while this waits for the old one's
// lock, Postgres re-checks the old row once the lock is free, finds it's no longer current and
// skips it -- and the new current plan, saved after this statement started, isn't seen by it. So
// "no row" came back even though the wedding has a current plan, and the change went ahead as if
// there were no plan (a table edit wasn't re-checked against the new one, say). Each new statement
// sees everything saved before it starts, so asking again finds the new plan. A wedding with no plan
// at all just gets "none" a few times over, which costs next to nothing.
const LOCK_CURRENT_PLAN_ATTEMPTS = 4;

export async function lockCurrentPlan(q: Queryable, weddingId: string): Promise<string | null> {
  for (let attempt = 1; attempt <= LOCK_CURRENT_PLAN_ATTEMPTS; attempt++) {
    // TS-187: NO KEY UPDATE -- see resyncSeatsAtTable.
    const { rows } = await q.query(
      `SELECT id FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" FOR NO KEY UPDATE`,
      [weddingId]
    );
    if (rows[0]) return rows[0].id as string;
    // Nothing current, even to a fresh look: the wedding really has no current plan.
    const { rows: current } = await q.query(
      `SELECT 1 FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" LIMIT 1`,
      [weddingId]
    );
    if (!current[0]) return null;
  }
  // The current plan kept being replaced while this waited -- give up rather than act as if there
  // were none. 40001 is Postgres's own "try again" code; routes answer it with a 409.
  throw Object.assign(new Error("The current plan kept changing while this was being saved."), { code: "40001" });
}

// TS-181: taken (right after lockCurrentPlan) by everything that checks a new seating rule against
// the Restricted tables' required-guest lists or the other way round -- saving a list, editing a
// Restricted table, adding a rule -- so one can't pass its checks against the other's old state.
// The plan's lock does this too, but a wedding may not have a plan yet.
export async function lockRestrictedLists(q: Queryable, weddingId: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`restricted-lists:${weddingId}`]);
}

// FR-8.1 / TS-174: the write half of an attendance change, on the caller's transaction -- which
// has already taken the wedding lock, then the current plan's row (lockCurrentPlan), then the
// guest's row, and checked the guest isn't already at `attendance`. Shared by setGuestAttendance
// and a guest's own RSVP (submitGuestRsvp), so their answer and its effect on the plan are saved
// together or not at all. Not Attending frees their seat (and re-checks the tables that touches);
// either way the plan's completeness is recounted, its revision bumped and the change recorded.
// `seatFreed` says whether they actually had a seat, so a message never claims one was freed.
export async function applyAttendanceChange(
  client: Queryable,
  weddingId: string,
  planVersionId: string | null,
  guest: { id: string; name: string },
  attendance: "ATTENDING" | "NOT_ATTENDING",
  actorUserId: string | null
): Promise<{ seatFreed: boolean }> {
  // TS-165: bumps the guest's revision too, so a planner editing this guest from an older copy
  // gets a conflict instead of overwriting the attendance change.
  await client.query(
    `UPDATE "guests" SET "dayOfAttendance" = $1::"DayOfAttendance", revision = revision + 1, "updatedAt" = now() WHERE id = $2`,
    [attendance, guest.id]
  );
  if (!planVersionId) return { seatFreed: false };

  let seatFreed = false;
  if (attendance === "NOT_ATTENDING") {
    // TS-165: the freed seat can make room for someone flagged at that table, and a rule partner's
    // flag may no longer apply -- re-check those tables.
    const affected = await tablesAffectedBy(client, weddingId, planVersionId, [guest.id]);
    const { rowCount } = await client.query(
      `DELETE FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2`,
      [planVersionId, guest.id]
    );
    seatFreed = (rowCount ?? 0) > 0;
    await resyncTables(client, weddingId, planVersionId, affected);
  }
  // Recompute completeness against the new attendance-filtered denominator -- a guest who just
  // became Not Attending can no longer make the plan incomplete by being unseated, and one who
  // just became Attending again can. FR-4.6: other Needs Reassignment flags still count.
  // TS-165: every other seat change bumps the plan's revision; this one does too.
  await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: true });

  const description =
    attendance === "NOT_ATTENDING"
      ? `${guest.name} marked not attending${seatFreed ? " — seat freed" : ""}`
      : `${guest.name} marked attending again — now unassigned`;
  await client.query(
    `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId", "createdAt")
     VALUES ($1, $2, 'ATTENDANCE_CHANGE', $3, $4, ${HISTORY_CREATED_AT})`,
    [randomUUID(), planVersionId, description, actorUserId]
  );
  return { seatFreed };
}

/** The Current Plan Version's id for a wedding, if there is one. */
export async function currentPlanVersionId(q: Queryable, weddingId: string): Promise<string | null> {
  const { rows } = await q.query(`SELECT id FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" LIMIT 1`, [
    weddingId,
  ]);
  return (rows[0]?.id as string | undefined) ?? null;
}

// FR-2.9 / TS-150: after something about one or more guests changes (an edit, a new or removed
// seating rule), re-check every table they're seated at in the Current Plan Version, in one
// transaction. Returns who got newly flagged.
export async function resyncGuestsSeats(
  weddingId: string,
  guestIds: string[]
): Promise<{ newlyFlagged: NewlyFlaggedSeat[] }> {
  if (guestIds.length === 0) return { newlyFlagged: [] };
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const planVersionId = await lockCurrentPlan(client, weddingId);
    if (!planVersionId) {
      await client.query("COMMIT");
      return { newlyFlagged: [] };
    }
    const { rows } = await client.query(
      `SELECT DISTINCT "seatingTableId" AS "tableId" FROM "seat_assignments"
       WHERE "planVersionId" = $1 AND "guestId" = ANY($2::text[])
       ORDER BY 1`,
      [planVersionId, guestIds]
    );
    const newlyFlagged: NewlyFlaggedSeat[] = [];
    let changed = false;
    for (const { tableId } of rows as { tableId: string }[]) {
      const result = await resyncSeatsAtTable(client, weddingId, planVersionId, tableId);
      newlyFlagged.push(...result.newlyFlagged);
      changed ||= result.changed;
    }
    await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: changed });
    if (changed) await recordRecheckIfApproved(client, planVersionId, "Seating re-checked after a change — some guests' Needs Reassignment flags changed", null);
    await client.query("COMMIT");
    return { newlyFlagged };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// FR-2.9: called after a guest edit changes side, tier, household or requires-accessible-table.
// TS-150: now re-checks the guest's whole table (rules *and* room), so it can never clear a flag
// that's still deserved. Returns null when the guest isn't seated in the Current Plan Version.
export async function revalidateGuestAssignment(
  weddingId: string,
  guestId: string
): Promise<{ guestName: string; flagged: boolean } | null> {
  const planVersionId = await currentPlanVersionId(pool, weddingId);
  if (!planVersionId) return null;
  const { rows: before } = await pool.query(
    `SELECT 1 FROM "seat_assignments" WHERE "planVersionId" = $1 AND "guestId" = $2`,
    [planVersionId, guestId]
  );
  if (!before[0]) return null;
  await resyncGuestsSeats(weddingId, [guestId]);
  const { rows } = await pool.query(
    `SELECT (g."firstName" || ' ' || g."lastName") AS name, sa."needsReassignment"
     FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId"
     WHERE sa."planVersionId" = $1 AND sa."guestId" = $2`,
    [planVersionId, guestId]
  );
  const row = rows[0] as { name: string; needsReassignment: boolean } | undefined;
  return row ? { guestName: row.name, flagged: row.needsReassignment } : null;
}
