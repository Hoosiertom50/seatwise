import { pool } from "../pool";

// TS-150: every check of "does the Current Plan Version still keep the hard rules?" lives here, in
// one place, so the guest edit, the guest import, a new or removed seating rule and a table edit
// all flag (and un-flag) Needs Reassignment the same way. Before, the guest-level re-check looked
// only at accessible / restricted / must-not rules and *wrote* its answer -- so editing a guest who
// was flagged because their table was over capacity cleared that flag, and the plan could be
// approved with too many people at a table.

// A minimal "Queryable" so a check can run against the shared pool or inside an already-open
// transaction's client (a bulk import, so the check is part of the same all-or-nothing write).
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
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

export type TableSeatingFlagReason = "accessible" | "capacity" | "restricted" | "rule";

// FR-4.6 / TS-120 / TS-150: re-checks everyone seated at one table in the given plan version and
// sets Needs Reassignment exactly where a hard rule is broken or the table has no room left for
// them -- flagging and clearing alike, so the answer is always the whole truth for that table.
// Nobody is ever unseated. Who "no longer fits": locked guests keep their place first, then guests
// in the order they were seated; whoever pushes the headcount past capacity is flagged. Runs on
// the caller's client; the caller owns the transaction and recomputes isComplete.
export async function resyncSeatsAtTable(
  client: Queryable,
  weddingId: string,
  planVersionId: string,
  tableId: string
): Promise<{ newlyFlagged: { guestId: string; name: string; reason: TableSeatingFlagReason }[]; changed: boolean }> {
  const { rows: tableRows } = await client.query(
    `SELECT capacity, "isRestricted", "isAccessible" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
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
     ORDER BY g."isLocked" DESC, sa."createdAt", sa.id
     FOR UPDATE OF sa`,
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

  const newlyFlagged: { guestId: string; name: string; reason: TableSeatingFlagReason }[] = [];
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
        newlyFlagged.push({ guestId: a.guestId, name: a.name, reason });
      }
    }
  }
  return { newlyFlagged, changed };
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
): Promise<{ newlyFlagged: { guestId: string; name: string; reason: TableSeatingFlagReason }[] }> {
  const planVersionId = await currentPlanVersionId(pool, weddingId);
  if (!planVersionId || guestIds.length === 0) return { newlyFlagged: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT DISTINCT "seatingTableId" AS "tableId" FROM "seat_assignments"
       WHERE "planVersionId" = $1 AND "guestId" = ANY($2::text[])
       ORDER BY 1`,
      [planVersionId, guestIds]
    );
    const newlyFlagged: { guestId: string; name: string; reason: TableSeatingFlagReason }[] = [];
    let changed = false;
    for (const { tableId } of rows as { tableId: string }[]) {
      const result = await resyncSeatsAtTable(client, weddingId, planVersionId, tableId);
      newlyFlagged.push(...result.newlyFlagged);
      changed ||= result.changed;
    }
    await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: changed });
    await client.query("COMMIT");
    return { newlyFlagged };
  } catch (err) {
    await client.query("ROLLBACK");
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
