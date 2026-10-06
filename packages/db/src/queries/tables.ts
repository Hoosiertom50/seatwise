import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { pool, beginTransaction } from "../pool";
import { compareTableLabels } from "@seatwise/shared";
import {
  resyncTables,
  refreshPlanCompleteness,
  lockCurrentPlan,
  recordRecheckIfApproved,
  tablesAffectedBy,
  lockRestrictedLists,
  HISTORY_CREATED_AT,
  type NewlyFlaggedSeat,
} from "./seat-checks";

export interface SeatingTableRow {
  id: string;
  weddingId: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
  purpose: string | null;
  // FR-3.7
  purposeCriterionType: string | null;
  purposeCriterionValue: string | null;
  // FR-3.4
  singleSideOnly: boolean;
  // FR-4.1: drawing-only -- never read by seating logic.
  shape: string;
  // FR-4.3: null until this table has been placed on the floor plan at least once.
  positionX: number | null;
  positionY: number | null;
  // FR-3.7a: only ever populated for a Restricted table.
  requiredGuestIds: string[];
  createdAt: Date;
  updatedAt: Date;
  // FR-7.7: an optimistic-concurrency counter for this table -- an edit that names an
  // expectedRevision the server no longer matches is rejected as stale.
  revision: number;
}

// Every read joins in the current required-guest list (FR-3.7a) as an aggregated array, so
// callers never need a second round-trip just to show a Restricted table's list.
const SELECT_WITH_REQUIRED = `
  SELECT t.id, t."weddingId", t.label, t.capacity, t."isRestricted", t."isAccessible", t."isLocked",
         t.purpose, t."purposeCriterionType", t."purposeCriterionValue", t."singleSideOnly", t.shape,
         t."positionX", t."positionY", t.revision,
         t."createdAt", t."updatedAt",
         COALESCE(rtg."guestIds", ARRAY[]::text[]) AS "requiredGuestIds"
  FROM "seating_tables" t
  -- TS-165: only a Restricted table has a required-guest list (one left behind on a table that
  -- was later unmarked is ignored).
  LEFT JOIN (
    SELECT "tableId", array_agg("guestId") AS "guestIds" FROM "restricted_table_guests" GROUP BY "tableId"
  ) rtg ON rtg."tableId" = t.id AND t."isRestricted"
`;

// FR-7.7: thrown instead of applying an edit whose expectedRevision no longer matches the table's
// current one -- the fresh, up-to-date table is attached so the caller can refresh the UI with it
// directly rather than making a second round-trip.
export class TableConflictError extends Error {
  table: SeatingTableRow;
  constructor(message: string, table: SeatingTableRow) {
    super(message);
    this.table = table;
  }
}

export interface CreateSeatingTableData {
  label: string;
  capacity: number;
  isRestricted?: boolean;
  isAccessible?: boolean;
  isLocked?: boolean;
  purpose?: string | null;
  purposeCriterionType?: string | null;
  purposeCriterionValue?: string | null;
  singleSideOnly?: boolean;
  shape?: string;
  positionX?: number | null;
  positionY?: number | null;
}

export class RestrictedTableError extends Error {}

// FR-4.3: a simple grid fallback position for a table that's never been explicitly placed --
// four columns, spaced widely enough for the floor-plan's table boxes not to overlap. Purely a
// starting point the planner can drag from; never read by seating logic. Column/row spacing here
// must stay wider than the frontend's PLAN_BOX_WIDTH (224px) and fixed table-box height (200px)
// respectively, plus a real gap -- these two constants aren't shared code across the frontend/
// backend boundary, so keep them in sync by hand if either box size changes.
function gridPosition(index: number): { x: number; y: number } {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return { x: 40 + col * 264, y: 40 + row * 240 };
}

export async function createSeatingTable(
  weddingId: string,
  input: CreateSeatingTableData
): Promise<SeatingTableRow> {
  const id = randomUUID();
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM "seating_tables" WHERE "weddingId" = $1`,
    [weddingId]
  );
  const { x, y } = gridPosition(countRows[0].count);
  const { rows } = await pool.query(
    `INSERT INTO "seating_tables"
       (id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
        "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape, "positionX", "positionY", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::"TablePurposeCriterionType", $10, $11, $12::"TableShape", $13, $14, now())
     RETURNING id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose,
               "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape, "positionX", "positionY", revision, "createdAt", "updatedAt"`,
    [
      id,
      weddingId,
      input.label,
      input.capacity,
      input.isRestricted ?? false,
      input.isAccessible ?? false,
      input.isLocked ?? false,
      input.purpose ?? null,
      input.purposeCriterionType ?? null,
      input.purposeCriterionValue ?? null,
      input.singleSideOnly ?? false,
      input.shape ?? "ROUND",
      input.positionX ?? x,
      input.positionY ?? y,
    ]
  );
  return { ...rows[0], requiredGuestIds: [] };
}

// FR-4.2: create a standard set of same-shape, same-capacity tables in one action (e.g. "12 round
// tables of 8"). Numbering continues after the highest number already used with that prefix, so a
// repeated quick-create (or one run after tables were added or deleted) never repeats a label.
export async function quickCreateSeatingTables(
  weddingId: string,
  input: { count: number; capacity: number; shape: string; labelPrefix: string }
): Promise<SeatingTableRow[]> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows: existingRows } = await client.query<{ label: string }>(
      `SELECT label FROM "seating_tables" WHERE "weddingId" = $1`,
      [weddingId]
    );
    // Grid placement continues after however many tables there are.
    const startIndex = existingRows.length;
    // TS-153: numbering continues after the highest number already used with this prefix (not
    // the table count) -- after "Table 2" of five was deleted, the count-based numbering made a
    // second "Table 5". Labels already taken are skipped either way.
    const taken = new Set(existingRows.map((r) => r.label.trim().toLowerCase()));
    const prefix = input.labelPrefix.trim();
    const numberPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)$`, "i");
    let next =
      existingRows.reduce((max, r) => {
        const m = r.label.trim().match(numberPattern);
        return m ? Math.max(max, Number(m[1])) : max;
      }, 0) + 1;
    const labels: string[] = [];
    while (labels.length < input.count) {
      const label = `${prefix} ${next++}`;
      if (!taken.has(label.toLowerCase())) labels.push(label);
    }
    const created: SeatingTableRow[] = [];
    for (let i = 0; i < input.count; i++) {
      const id = randomUUID();
      const { x, y } = gridPosition(startIndex + i);
      const { rows } = await client.query(
        `INSERT INTO "seating_tables"
           (id, "weddingId", label, capacity, shape, "positionX", "positionY", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"TableShape", $6, $7, now())
         RETURNING id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked",
                   purpose, "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", shape,
                   "positionX", "positionY", revision, "createdAt", "updatedAt"`,
        [id, weddingId, labels[i], input.capacity, input.shape, x, y]
      );
      created.push({ ...rows[0], requiredGuestIds: [] });
    }
    await client.query("COMMIT");
    return created;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listSeatingTablesForWedding(weddingId: string): Promise<SeatingTableRow[]> {
  // ORDER BY here is just a stable baseline (creation order) for ties -- a plain SQL sort on
  // `label` would put "Table 10"/"Table 11" ahead of "Table 2" because it compares character by
  // character rather than by numeric value. The real ordering is applied below with a
  // numeric-aware comparator so tables read back in the order a person actually expects
  // ("Table 1, Table 2, ... Table 10, Table 11").
  const { rows } = await pool.query(
    `${SELECT_WITH_REQUIRED} WHERE t."weddingId" = $1 ORDER BY t."createdAt"`,
    [weddingId]
  );
  return rows.sort((a, b) => compareTableLabels(a.label, b.label));
}

export async function getSeatingTableForWedding(id: string, weddingId: string): Promise<SeatingTableRow | null> {
  const { rows } = await pool.query(
    `${SELECT_WITH_REQUIRED} WHERE t.id = $1 AND t."weddingId" = $2`,
    [id, weddingId]
  );
  return rows[0] ?? null;
}

// TS-181: a table as it will be once an edit is saved -- what a required-guest list is checked against.
interface TableAfterEdit {
  id: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
}

// FR-3.7a: everything a Restricted table's required-guest list has to satisfy, checked before
// anything is written. Throws RestrictedTableError with a plain-English reason.
async function validateRequiredList(
  client: PoolClient,
  weddingId: string,
  table: TableAfterEdit,
  uniqueIds: string[]
): Promise<void> {
  if (!table.isRestricted) {
    throw new RestrictedTableError(
      `"${table.label}" isn't marked as a Restricted table — mark it Restricted before giving it a required-guest list.`
    );
  }
  if (uniqueIds.length === 0) return;
  const { rows: guestRows } = await client.query<{
    id: string;
    name: string;
    headcount: number;
    requiresAccessibleTable: boolean;
    dayOfAttendance: string;
  }>(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount, "requiresAccessibleTable", "dayOfAttendance"
     FROM "guests" WHERE id = ANY($1::text[]) AND "weddingId" = $2
     ORDER BY id FOR NO KEY UPDATE`,
    [uniqueIds, weddingId]
  );
  // TS-187: the listed guests are locked (above) while the list is checked and saved, so a party
  // size or accessible-seat change saved at the same moment can't slip past the checks below.
  if (guestRows.length !== uniqueIds.length) {
    throw new RestrictedTableError("One or more guest IDs don't belong to this wedding.");
  }
  // TS-188: only guests who are Attending need a seat; someone marked Not Attending doesn't count.
  const totalHeadcount = guestRows
    .filter((g) => g.dayOfAttendance === "ATTENDING")
    .reduce((sum, g) => sum + g.headcount, 0);
  if (totalHeadcount > table.capacity) {
    throw new RestrictedTableError(
      `This list needs ${totalHeadcount} seat(s), but "${table.label}" only has ${table.capacity}.`
    );
  }
  // TS-181: a guest who needs an accessible table can only be required at an accessible one --
  // otherwise the only table they're allowed at is one they can't use.
  if (!table.isAccessible) {
    const needAccessible = guestRows.filter((g) => g.requiresAccessibleTable).map((g) => g.name);
    if (needAccessible.length > 0) {
      throw new RestrictedTableError(
        `${needAccessible.join(", ")} ${needAccessible.length === 1 ? "needs" : "need"} an accessible table, and "${table.label}" isn't marked Accessible — mark it Accessible first, or leave ${needAccessible.length === 1 ? "them" : "those guests"} off its list.`
      );
    }
  }

  // FR-3.7a: a guest can be required at only one Restricted table wedding-wide. (TS-165: a list
  // left behind on a table that's no longer Restricted doesn't count -- it's cleared on save.)
  const { rows: conflictRows } = await client.query(
    `SELECT (g."firstName" || ' ' || g."lastName") AS "guestName", t.label AS "tableLabel"
     FROM "restricted_table_guests" rtg
     JOIN "guests" g ON g.id = rtg."guestId"
     JOIN "seating_tables" t ON t.id = rtg."tableId"
     WHERE rtg."guestId" = ANY($1::text[]) AND rtg."tableId" != $2 AND t."isRestricted"
     LIMIT 1`,
    [uniqueIds, table.id]
  );
  if (conflictRows[0]) {
    const c = conflictRows[0];
    throw new RestrictedTableError(
      `${c.guestName} is already required at "${c.tableLabel}" — a guest can only be required at one Restricted table.`
    );
  }
  // TS-173: guests who must sit together go on the list together, or not at all -- otherwise one
  // of them is required at this table and the other isn't allowed at it, and no seat works.
  const { rows: partnerRows } = await client.query(
    `SELECT (ga."firstName" || ' ' || ga."lastName") AS "listed", (gb."firstName" || ' ' || gb."lastName") AS "partner"
     FROM "guest_relationships" gr
     JOIN "guests" ga ON ga.id = CASE WHEN gr."guestAId" = ANY($1::text[]) THEN gr."guestAId" ELSE gr."guestBId" END
     JOIN "guests" gb ON gb.id = CASE WHEN gr."guestAId" = ANY($1::text[]) THEN gr."guestBId" ELSE gr."guestAId" END
     WHERE gr."weddingId" = $2 AND gr.type = 'MUST_SIT_TOGETHER'
       AND (gr."guestAId" = ANY($1::text[])) <> (gr."guestBId" = ANY($1::text[]))
     LIMIT 1`,
    [uniqueIds, weddingId]
  );
  if (partnerRows[0]) {
    throw new RestrictedTableError(
      `${partnerRows[0].listed} must sit together with ${partnerRows[0].partner}, so they go on this list together or not at all.`
    );
  }
  // TS-181: and two guests who must not sit together can't both be required at the same table.
  const { rows: apartRows } = await client.query(
    `SELECT (ga."firstName" || ' ' || ga."lastName") AS "a", (gb."firstName" || ' ' || gb."lastName") AS "b"
     FROM "guest_relationships" gr
     JOIN "guests" ga ON ga.id = gr."guestAId"
     JOIN "guests" gb ON gb.id = gr."guestBId"
     WHERE gr."weddingId" = $2 AND gr.type = 'MUST_NOT_SIT_TOGETHER'
       AND gr."guestAId" = ANY($1::text[]) AND gr."guestBId" = ANY($1::text[])
     LIMIT 1`,
    [uniqueIds, weddingId]
  );
  if (apartRows[0]) {
    throw new RestrictedTableError(
      `${apartRows[0].a} and ${apartRows[0].b} must not sit together, so they can't both be on "${table.label}"'s required-guest list.`
    );
  }
}

// FR-3.7a: writes a list that validateRequiredList has passed, replacing the table's old one.
// Returns the guests added to or taken off it (their seats need re-checking).
async function saveRequiredList(client: PoolClient, tableId: string, uniqueIds: string[]): Promise<string[]> {
  const { rows: beforeRows } = await client.query<{ guestId: string }>(
    `SELECT "guestId" FROM "restricted_table_guests" WHERE "tableId" = $1`,
    [tableId]
  );
  const before = new Set(beforeRows.map((r) => r.guestId));
  if (uniqueIds.length > 0) {
    // TS-165: drop these guests from any list left behind on a table that's no longer Restricted
    // (lists from before unmarking cleared them), so it can't block them here.
    await client.query(
      `DELETE FROM "restricted_table_guests" rtg USING "seating_tables" t
       WHERE rtg."tableId" = t.id AND NOT t."isRestricted" AND rtg."guestId" = ANY($1::text[])`,
      [uniqueIds]
    );
  }
  await client.query(`DELETE FROM "restricted_table_guests" WHERE "tableId" = $1`, [tableId]);
  if (uniqueIds.length > 0) {
    await client.query(
      `INSERT INTO "restricted_table_guests" (id, "tableId", "guestId")
       SELECT id, $1, "guestId" FROM unnest($2::text[], $3::text[]) AS x(id, "guestId")`,
      [tableId, uniqueIds.map(() => randomUUID()), uniqueIds]
    );
  }
  return [...uniqueIds.filter((id) => !before.has(id)), ...[...before].filter((id) => !uniqueIds.includes(id))];
}

// TS-173/TS-181: re-checks this table and every table where any of `guestIds` sits, then keeps
// the plan's completeness (and an approved plan's history) in step -- on the caller's transaction.
async function recheckAfterTableChange(
  client: PoolClient,
  weddingId: string,
  planVersionId: string,
  tableId: string,
  guestIds: string[],
  description: string
): Promise<NewlyFlaggedSeat[]> {
  const { rows: seatedAt } = await client.query<{ tableId: string }>(
    `SELECT DISTINCT "seatingTableId" AS "tableId" FROM "seat_assignments"
     WHERE "planVersionId" = $1 AND "guestId" = ANY($2::text[])`,
    [planVersionId, guestIds]
  );
  const result = await resyncTables(client, weddingId, planVersionId, [tableId, ...seatedAt.map((r) => r.tableId)]);
  await refreshPlanCompleteness(client, weddingId, planVersionId, { bumpRevision: result.changed });
  if (result.changed) await recordRecheckIfApproved(client, planVersionId, description, null);
  return result.newlyFlagged;
}

// TS-165: two tables claiming the same guest at the same moment -- the database's
// one-list-per-guest rule stops the second; say so instead of failing with a 500.
function listRaceError(err: unknown): unknown {
  return (err as { code?: string }).code === "23505"
    ? new RestrictedTableError("Someone just put one of these guests on another Restricted table's list — refresh and try again.")
    : err;
}

// FR-7.7, extended to seating tables: an optional expectedRevision locks the table's row (FOR
// UPDATE, inside this function's own transaction) and compares it against the current revision
// before writing anything. A mismatch means someone else's edit landed first -- rather than
// proceeding on stale data, this throws TableConflictError with the fresh, currently-committed
// table attached (a plain read from a second connection isn't blocked by the row lock, so it
// safely sees the latest committed state) and writes nothing. A caller that passes no
// expectedRevision at all (an internal/legacy call site) skips the check entirely, matching the
// plan-version pattern.
// TS-181: the table's changes, its required-guest list (if this edit sends one) and the re-check
// of everyone they affect are now one transaction. Before, the table was saved first and the list
// after, so a list that couldn't be saved left the table's new (smaller) seat count in place --
// fewer seats than its required guests need. Now the list is checked against the table as it will
// be, and if anything is wrong nothing at all is saved. Returns null if there's no such table.
export async function updateSeatingTableForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateSeatingTableData>,
  expectedRevision?: number,
  /** The required-guest list this same edit saves, if it saves one. */
  requiredGuestIds?: string[]
): Promise<{ newlyFlagged: NewlyFlaggedSeat[] } | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.label !== undefined) {
    fields.push(`label = $${i++}`);
    values.push(input.label);
  }
  if (input.capacity !== undefined) {
    fields.push(`capacity = $${i++}`);
    values.push(input.capacity);
  }
  if (input.isRestricted !== undefined) {
    fields.push(`"isRestricted" = $${i++}`);
    values.push(input.isRestricted);
  }
  if (input.isAccessible !== undefined) {
    fields.push(`"isAccessible" = $${i++}`);
    values.push(input.isAccessible);
  }
  if (input.isLocked !== undefined) {
    fields.push(`"isLocked" = $${i++}`);
    values.push(input.isLocked);
  }
  if (input.purpose !== undefined) {
    fields.push(`purpose = $${i++}`);
    values.push(input.purpose);
  }
  // FR-3.7: always written together (validated as a pair at the schema level) -- a table's
  // criterion is replaced wholesale rather than patched field-by-field.
  if (input.purposeCriterionType !== undefined) {
    fields.push(`"purposeCriterionType" = $${i++}::"TablePurposeCriterionType"`);
    values.push(input.purposeCriterionType);
  }
  if (input.purposeCriterionValue !== undefined) {
    fields.push(`"purposeCriterionValue" = $${i++}`);
    values.push(input.purposeCriterionValue);
  }
  if (input.singleSideOnly !== undefined) {
    fields.push(`"singleSideOnly" = $${i++}`);
    values.push(input.singleSideOnly);
  }
  if (input.shape !== undefined) {
    fields.push(`shape = $${i++}::"TableShape"`);
    values.push(input.shape);
  }
  if (input.positionX !== undefined) {
    fields.push(`"positionX" = $${i++}`);
    values.push(input.positionX);
  }
  if (input.positionY !== undefined) {
    fields.push(`"positionY" = $${i++}`);
    values.push(input.positionY);
  }
  // TS-181: only an edit that can change who may sit here takes the plan's locks (moving a table
  // around the floor plan doesn't).
  const seatingChange =
    input.capacity !== undefined ||
    input.isRestricted !== undefined ||
    input.isAccessible !== undefined ||
    requiredGuestIds !== undefined;
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-181: the usual lock order -- the current plan, then (as a new seating rule does, so a rule
    // and a list can't each pass their checks against the other's old state) the lists, then the
    // table.
    let planVersionId: string | null = null;
    if (seatingChange) {
      planVersionId = await lockCurrentPlan(client, weddingId);
      await lockRestrictedLists(client, weddingId);
    }
    const { rows } = await client.query<{
      revision: number;
      label: string;
      capacity: number;
      isRestricted: boolean;
      isAccessible: boolean;
    }>(
      // TS-187: NO KEY UPDATE -- see resyncSeatsAtTable in seat-checks.ts.
      `SELECT revision, label, capacity, "isRestricted", "isAccessible" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      // TS-187: the locks are let go before the fresh copy is read on another connection.
      await client.query("ROLLBACK").catch(() => {});
      const fresh = await getSeatingTableForWedding(id, weddingId);
      throw new TableConflictError(
        "This table changed since you loaded it (maybe in another tab, or by someone else). It's been refreshed with the latest — check it and make your change again if it's still needed.",
        fresh!
      );
    }
    const after: TableAfterEdit = {
      id,
      label: input.label ?? current.label,
      capacity: input.capacity ?? current.capacity,
      isRestricted: input.isRestricted ?? current.isRestricted,
      isAccessible: input.isAccessible ?? current.isAccessible,
    };
    // An empty list on a table that ends up not Restricted is simply nothing to save.
    const listIds =
      requiredGuestIds !== undefined && (after.isRestricted || requiredGuestIds.length > 0)
        ? [...new Set(requiredGuestIds)]
        : undefined;

    if (listIds) {
      // TS-181: the new list, against the table as this edit leaves it -- before anything is written.
      await validateRequiredList(client, weddingId, after, listIds);
    } else if (after.isRestricted && current.isRestricted) {
      const { rows: listRows } = await client.query<{
        name: string;
        headcount: number;
        requiresAccessibleTable: boolean;
        dayOfAttendance: string;
      }>(
        `SELECT (g."firstName" || ' ' || g."lastName") AS name, g.headcount, g."requiresAccessibleTable", g."dayOfAttendance"
         FROM "restricted_table_guests" rtg JOIN "guests" g ON g.id = rtg."guestId"
         WHERE rtg."tableId" = $1`,
        [id]
      );
      // TS-173: a Restricted table can't have fewer seats than its required guests need. Before, the
      // list was checked against the seats only when the list was saved, so lowering the seats
      // afterwards left required guests with nowhere they're allowed to sit.
      // TS-188: counting only the guests who are Attending.
      const seats = listRows
        .filter((g) => g.dayOfAttendance === "ATTENDING")
        .reduce((sum, g) => sum + g.headcount, 0);
      if (input.capacity !== undefined && seats > after.capacity) {
        throw new RestrictedTableError(
          `This table's required guests need ${seats} seat(s), so it can't have fewer than that. Take guests off its list first.`
        );
      }
      // TS-181: nor can it stop being accessible while someone on its list needs an accessible table.
      const needAccessible = listRows.filter((g) => g.requiresAccessibleTable).map((g) => g.name);
      if (!after.isAccessible && current.isAccessible && needAccessible.length > 0) {
        throw new RestrictedTableError(
          `"${after.label}" has to stay Accessible: ${needAccessible.join(", ")} on its required-guest list ${needAccessible.length === 1 ? "needs" : "need"} an accessible table. Take ${needAccessible.length === 1 ? "them" : "those guests"} off its list first.`
        );
      }
    }

    if (fields.length > 0) {
      fields.push(`"updatedAt" = now()`, `revision = revision + 1`);
      values.push(id, weddingId);
      await client.query(
        `UPDATE "seating_tables" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
        values
      );
    }
    // TS-165: a table that's no longer Restricted has no required-guest list. Leaving the list in
    // place kept those guests pinned to it (they couldn't be moved, and Generate put them back),
    // with no way to clear it, since only a Restricted table's list can be edited.
    // TS-173: the guests who were on it (and flagged for sitting elsewhere) are re-checked where they sit.
    const recheckGuestIds: string[] = [];
    if (input.isRestricted === false) {
      const { rows: former } = await client.query<{ guestId: string }>(
        `DELETE FROM "restricted_table_guests" WHERE "tableId" = $1 RETURNING "guestId"`,
        [id]
      );
      recheckGuestIds.push(...former.map((r) => r.guestId));
    }
    if (listIds) recheckGuestIds.push(...(await saveRequiredList(client, id, listIds)));

    // FR-4.6 / TS-120: an edit that can invalidate who's seated here -- accessible on/off, seats
    // changed, restricted on/off, a new list -- re-checks everyone at this table (and, TS-173,
    // wherever the guests added to or taken off its list sit) in the current plan, flagging (or
    // clearing) Needs Reassignment. Nobody is ever unseated. TS-181: in this same transaction.
    let newlyFlagged: NewlyFlaggedSeat[] = [];
    if (planVersionId) {
      newlyFlagged = await recheckAfterTableChange(
        client,
        weddingId,
        planVersionId,
        id,
        recheckGuestIds,
        listIds
          ? `"${after.label}"'s required-guest list changed — some guests' Needs Reassignment flags changed`
          : "Seating re-checked after a change — some guests' Needs Reassignment flags changed"
      );
    }
    await client.query("COMMIT");
    return { newlyFlagged };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw listRaceError(err);
  } finally {
    client.release();
  }
}

export type RemoveTableResult =
  | { status: "NOT_FOUND" }
  | { status: "NEEDS_CONFIRMATION"; label: string; seatedCount: number }
  | { status: "REMOVED"; label: string; seatedCount: number };

// TS-124: removing a table takes every seat assignment at it with it (ON DELETE CASCADE), so it
// must never be silent about the guests seated there. If the current plan seats anyone at this
// table, nothing happens unless the caller confirms; once it does, the current plan is kept honest
// in the same transaction -- isComplete recomputed (those guests are now unassigned), revision
// bumped, and a change-history entry written, which is also what raises "Modified since approval"
// on an Approved plan (FR-6.6). An empty table is simply removed.
//
// Known limit: past (non-current) versions lose their assignments at this table too, through the
// same cascade -- keeping them needs a schema change and is tracked separately.
export async function removeSeatingTable(
  id: string,
  weddingId: string,
  actorUserId: string,
  confirmed: boolean
): Promise<RemoveTableResult> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-173: the current plan's row first, then the table (see lockCurrentPlan). TS-181: and the
    // lists in between -- a Restricted table's list goes with it.
    const currentPlanId = await lockCurrentPlan(client, weddingId);
    await lockRestrictedLists(client, weddingId);
    // TS-187: a full FOR UPDATE here (not NO KEY UPDATE, as elsewhere) because the table is deleted:
    // a seat being saved at it at the same moment waits, then finds it gone (a 409), rather than
    // the delete waiting on it while it waits on this plan's lock.
    const { rows: tableRows } = await client.query<{ label: string }>(
      `SELECT label FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [id, weddingId]
    );
    if (!tableRows[0]) {
      await client.query("ROLLBACK").catch(() => {});
      return { status: "NOT_FOUND" };
    }
    const label = tableRows[0].label;
    let seatedCount = 0;
    if (currentPlanId) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "seat_assignments" WHERE "planVersionId" = $1 AND "seatingTableId" = $2`,
        [currentPlanId, id]
      );
      seatedCount = rows[0].n;
    }
    if (seatedCount > 0 && !confirmed) {
      await client.query("ROLLBACK").catch(() => {});
      return { status: "NEEDS_CONFIRMATION", label, seatedCount };
    }

    // TS-181: the tables this removal can change, worked out before the seats go -- where the
    // seated guests' rule partners sit (a must-sit-together partner is no longer "apart" once
    // they're unseated), and, for a Restricted table, where the guests on its list sit (its list
    // goes with it, so they're no longer "required elsewhere"). Before, only completeness was
    // recounted, so those guests kept flags that no longer applied.
    let affected: string[] = [];
    if (currentPlanId) {
      const { rows: touched } = await client.query<{ guestId: string }>(
        `SELECT "guestId" FROM "seat_assignments" WHERE "planVersionId" = $1 AND "seatingTableId" = $2
         UNION SELECT "guestId" FROM "restricted_table_guests" WHERE "tableId" = $2`,
        [currentPlanId, id]
      );
      affected = await tablesAffectedBy(client, weddingId, currentPlanId, touched.map((r) => r.guestId));
    }

    await client.query(`DELETE FROM "seating_tables" WHERE id = $1`, [id]);

    let recheckChanged = false;
    if (currentPlanId) {
      recheckChanged = (await resyncTables(client, weddingId, currentPlanId, affected.filter((t) => t !== id))).changed;
    }
    if (currentPlanId && (seatedCount > 0 || recheckChanged)) {
      await refreshPlanCompleteness(client, weddingId, currentPlanId, { bumpRevision: true });
    }
    if (currentPlanId && seatedCount === 0 && recheckChanged) {
      await recordRecheckIfApproved(client, currentPlanId, `Table "${label}" removed — some guests' Needs Reassignment flags changed`, actorUserId);
    }
    if (currentPlanId && seatedCount > 0) {
      const guests = seatedCount === 1 ? "1 guest" : `${seatedCount} guests`;
      await client.query(
        `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId", "createdAt")
         VALUES ($1, $2, 'TABLE_REMOVED', $3, $4, ${HISTORY_CREATED_AT})`,
        [randomUUID(), currentPlanId, `Table "${label}" removed — ${guests} left unassigned`, actorUserId]
      );
    }

    await client.query("COMMIT");
    return { status: "REMOVED", label, seatedCount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// FR-3.7a: replace a Restricted table's entire required-guest list in one atomic operation — the
// requirement is explicit that an over-capacity or conflicting list "can't be saved", so this
// validates everything up front and writes nothing at all if any check fails.
export async function setRequiredGuestsForTable(
  tableId: string,
  weddingId: string,
  guestIds: string[]
): Promise<{ table: SeatingTableRow; newlyFlagged: NewlyFlaggedSeat[] }> {
  const client = await pool.connect();
  let newlyFlagged: NewlyFlaggedSeat[] = [];
  try {
    await beginTransaction(client);
    // TS-173: the current plan's row first, then the table (see lockCurrentPlan). TS-181: and the
    // lists in between, as a new seating rule takes them.
    const planVersionId = await lockCurrentPlan(client, weddingId);
    await lockRestrictedLists(client, weddingId);

    const { rows: tableRows } = await client.query<TableAfterEdit>(
      // TS-187: NO KEY UPDATE -- see resyncSeatsAtTable in seat-checks.ts.
      `SELECT id, label, capacity, "isRestricted", "isAccessible" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
      [tableId, weddingId]
    );
    const table = tableRows[0];
    if (!table) throw new RestrictedTableError("Table not found.");

    const uniqueIds = [...new Set(guestIds)];
    await validateRequiredList(client, weddingId, table, uniqueIds);
    const changed = await saveRequiredList(client, tableId, uniqueIds);

    // TS-173: re-check this table and every table where a guest added to or taken off the list is
    // seated, in the same transaction. Before, only this table was re-checked, so a guest put on the
    // list while seated somewhere else stayed there unflagged (and an approved plan stayed approved).
    if (planVersionId) {
      newlyFlagged = await recheckAfterTableChange(
        client,
        weddingId,
        planVersionId,
        tableId,
        changed,
        `"${table.label}"'s required-guest list changed — some guests' Needs Reassignment flags changed`
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw listRaceError(err);
  } finally {
    client.release();
  }

  const updated = await getSeatingTableForWedding(tableId, weddingId);
  if (!updated) throw new RestrictedTableError("Table not found after update.");
  return { table: updated, newlyFlagged };
}

// FR-4.6 / TS-120: after a table edit that can make its current seating invalid -- accessible
// switched off, seats lowered, or a restricted table's required list changed -- re-check everyone
// seated at it in the Current Plan Version (see resyncSeatsAtTable in seat-checks.ts for the rules)
// and keep isComplete in sync, all in one transaction. Nobody is ever unseated.
export async function resyncTableSeating(
  weddingId: string,
  tableId: string,
  /** TS-173: also re-check the tables these guests are seated at. */
  alsoGuestIds: string[] = []
): Promise<{ newlyFlagged: NewlyFlaggedSeat[] }> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-173: the current plan's row first, then the table (see lockCurrentPlan).
    const planVersionId = await lockCurrentPlan(client, weddingId);
    if (!planVersionId) {
      await client.query("COMMIT");
      return { newlyFlagged: [] };
    }
    const { rows: seatedAt } = await client.query(
      `SELECT DISTINCT "seatingTableId" AS "tableId" FROM "seat_assignments"
       WHERE "planVersionId" = $1 AND "guestId" = ANY($2::text[])`,
      [planVersionId, alsoGuestIds]
    );
    const { newlyFlagged, changed } = await resyncTables(client, weddingId, planVersionId, [
      tableId,
      ...seatedAt.map((r) => r.tableId as string),
    ]);
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

// TS-134: the same re-check for one guest, on whichever table they're seated at in the Current
// Plan Version -- for a change to the guest rather than the table that can make their seat invalid:
// needing an accessible seat, or a bigger party than the table has room for. Used after a guest's
// own RSVP and after a planner edits their headcount. Does nothing if they aren't seated.
export async function resyncGuestSeat(
  weddingId: string,
  guestId: string
): Promise<{ newlyFlagged: NewlyFlaggedSeat[] }> {
  const { rows } = await pool.query<{ tableId: string }>(
    `SELECT sa."seatingTableId" AS "tableId"
     FROM "seat_assignments" sa JOIN "plan_versions" pv ON pv.id = sa."planVersionId"
     WHERE pv."weddingId" = $1 AND pv."isCurrent" AND sa."guestId" = $2`,
    [weddingId, guestId]
  );
  if (!rows[0]) return { newlyFlagged: [] };
  return resyncTableSeating(weddingId, rows[0].tableId);
}
