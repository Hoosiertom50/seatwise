import { randomUUID } from "crypto";
import { pool } from "../pool";
import { compareTableLabels } from "@seatwise/shared";
import { resyncSeatsAtTable, refreshPlanCompleteness, currentPlanVersionId, type TableSeatingFlagReason } from "./seat-checks";

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
  LEFT JOIN (
    SELECT "tableId", array_agg("guestId") AS "guestIds" FROM "restricted_table_guests" GROUP BY "tableId"
  ) rtg ON rtg."tableId" = t.id
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
    await client.query("BEGIN");
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
    await client.query("ROLLBACK");
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

// FR-7.7, extended to seating tables: an optional expectedRevision locks the table's row (FOR
// UPDATE, inside this function's own transaction) and compares it against the current revision
// before writing anything. A mismatch means someone else's edit landed first -- rather than
// proceeding on stale data, this throws TableConflictError with the fresh, currently-committed
// table attached (a plain read from a second connection isn't blocked by the row lock, so it
// safely sees the latest committed state) and writes nothing. A caller that passes no
// expectedRevision at all (an internal/legacy call site) skips the check entirely, matching the
// plan-version pattern.
export async function updateSeatingTableForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateSeatingTableData>,
  expectedRevision?: number
): Promise<boolean> {
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT revision FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return false;
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      const fresh = await getSeatingTableForWedding(id, weddingId);
      throw new TableConflictError(
        "This table changed since you loaded it — someone else's edit landed first. It's been refreshed with the latest — please try again.",
        fresh!
      );
    }
    if (fields.length > 0) {
      fields.push(`"updatedAt" = now()`, `revision = revision + 1`);
      values.push(id, weddingId);
      await client.query(
        `UPDATE "seating_tables" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
        values
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
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
    await client.query("BEGIN");
    const { rows: tableRows } = await client.query<{ label: string }>(
      `SELECT label FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [id, weddingId]
    );
    if (!tableRows[0]) {
      await client.query("ROLLBACK");
      return { status: "NOT_FOUND" };
    }
    const label = tableRows[0].label;

    const { rows: planRows } = await client.query<{ id: string }>(
      `SELECT id FROM "plan_versions" WHERE "weddingId" = $1 AND "isCurrent" FOR UPDATE`,
      [weddingId]
    );
    const currentPlanId = planRows[0]?.id;
    let seatedCount = 0;
    if (currentPlanId) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "seat_assignments" WHERE "planVersionId" = $1 AND "seatingTableId" = $2`,
        [currentPlanId, id]
      );
      seatedCount = rows[0].n;
    }
    if (seatedCount > 0 && !confirmed) {
      await client.query("ROLLBACK");
      return { status: "NEEDS_CONFIRMATION", label, seatedCount };
    }

    await client.query(`DELETE FROM "seating_tables" WHERE id = $1`, [id]);

    if (currentPlanId && seatedCount > 0) {
      // Same combined unassigned + needs-reassignment formula as recomputeCurrentPlanCompleteness.
      const { rows: countRows } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
              AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id)
           ) AS "unassignedCount",
           (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
             AS "needsReassignmentCount"`,
        [weddingId, currentPlanId]
      );
      const isComplete = countRows[0].unassignedCount === 0 && countRows[0].needsReassignmentCount === 0;
      await client.query(
        `UPDATE "plan_versions" SET "isComplete" = $1, revision = revision + 1 WHERE id = $2`,
        [isComplete, currentPlanId]
      );
      const guests = seatedCount === 1 ? "1 guest" : `${seatedCount} guests`;
      await client.query(
        `INSERT INTO "change_history_entries" (id, "planVersionId", action, description, "actorUserId")
         VALUES ($1, $2, 'TABLE_REMOVED', $3, $4)`,
        [randomUUID(), currentPlanId, `Table "${label}" removed — ${guests} left unassigned`, actorUserId]
      );
    }

    await client.query("COMMIT");
    return { status: "REMOVED", label, seatedCount };
  } catch (err) {
    await client.query("ROLLBACK");
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
): Promise<SeatingTableRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: tableRows } = await client.query(
      `SELECT id, label, capacity, "isRestricted" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [tableId, weddingId]
    );
    const table = tableRows[0];
    if (!table) throw new RestrictedTableError("Table not found.");
    if (!table.isRestricted) {
      throw new RestrictedTableError(
        `"${table.label}" isn't marked as a Restricted table — mark it Restricted before giving it a required-guest list.`
      );
    }

    const uniqueIds = [...new Set(guestIds)];
    if (uniqueIds.length > 0) {
      const { rows: guestRows } = await client.query(
        `SELECT id, ("firstName" || ' ' || "lastName") AS name, headcount
         FROM "guests" WHERE id = ANY($1::text[]) AND "weddingId" = $2`,
        [uniqueIds, weddingId]
      );
      if (guestRows.length !== uniqueIds.length) {
        throw new RestrictedTableError("One or more guest IDs don't belong to this wedding.");
      }
      const totalHeadcount = guestRows.reduce((sum, g) => sum + g.headcount, 0);
      if (totalHeadcount > table.capacity) {
        throw new RestrictedTableError(
          `This list needs ${totalHeadcount} seat(s), but "${table.label}" only has ${table.capacity}.`
        );
      }

      // FR-3.7a: a guest can be required at only one Restricted table wedding-wide.
      const { rows: conflictRows } = await client.query(
        `SELECT rtg."guestId", (g."firstName" || ' ' || g."lastName") AS "guestName", t.label AS "tableLabel"
         FROM "restricted_table_guests" rtg
         JOIN "guests" g ON g.id = rtg."guestId"
         JOIN "seating_tables" t ON t.id = rtg."tableId"
         WHERE rtg."guestId" = ANY($1::text[]) AND rtg."tableId" != $2`,
        [uniqueIds, tableId]
      );
      if (conflictRows.length > 0) {
        const c = conflictRows[0];
        throw new RestrictedTableError(
          `${c.guestName} is already required at "${c.tableLabel}" — a guest can only be required at one Restricted table.`
        );
      }
    }

    await client.query(`DELETE FROM "restricted_table_guests" WHERE "tableId" = $1`, [tableId]);
    for (const guestId of uniqueIds) {
      await client.query(
        `INSERT INTO "restricted_table_guests" (id, "tableId", "guestId") VALUES ($1, $2, $3)`,
        [randomUUID(), tableId, guestId]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const updated = await getSeatingTableForWedding(tableId, weddingId);
  if (!updated) throw new RestrictedTableError("Table not found after update.");
  return updated;
}

// FR-4.6 / TS-120: after a table edit that can make its current seating invalid -- accessible
// switched off, seats lowered, or a restricted table's required list changed -- re-check everyone
// seated at it in the Current Plan Version (see resyncSeatsAtTable in seat-checks.ts for the rules)
// and keep isComplete in sync, all in one transaction. Nobody is ever unseated.
export async function resyncTableSeating(
  weddingId: string,
  tableId: string
): Promise<{ newlyFlagged: { name: string; reason: TableSeatingFlagReason }[] }> {
  const planVersionId = await currentPlanVersionId(pool, weddingId);
  if (!planVersionId) return { newlyFlagged: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { newlyFlagged, changed } = await resyncSeatsAtTable(client, weddingId, planVersionId, tableId);
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

// TS-134: the same re-check for one guest, on whichever table they're seated at in the Current
// Plan Version -- for a change to the guest rather than the table that can make their seat invalid:
// needing an accessible seat, or a bigger party than the table has room for. Used after a guest's
// own RSVP and after a planner edits their headcount. Does nothing if they aren't seated.
export async function resyncGuestSeat(
  weddingId: string,
  guestId: string
): Promise<{ newlyFlagged: { name: string; reason: TableSeatingFlagReason }[] }> {
  const { rows } = await pool.query<{ tableId: string }>(
    `SELECT sa."seatingTableId" AS "tableId"
     FROM "seat_assignments" sa JOIN "plan_versions" pv ON pv.id = sa."planVersionId"
     WHERE pv."weddingId" = $1 AND pv."isCurrent" AND sa."guestId" = $2`,
    [weddingId, guestId]
  );
  if (!rows[0]) return { newlyFlagged: [] };
  return resyncTableSeating(weddingId, rows[0].tableId);
}
