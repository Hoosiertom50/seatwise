import { randomUUID } from "crypto";
import { pool } from "../pool";

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
// tables of 8"). Numbering continues after any tables that already exist, so a repeated
// quick-create (or one run after tables were added by hand) never collides with earlier labels.
export async function quickCreateSeatingTables(
  weddingId: string,
  input: { count: number; capacity: number; shape: string; labelPrefix: string }
): Promise<SeatingTableRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM "seating_tables" WHERE "weddingId" = $1`,
      [weddingId]
    );
    const startIndex = countRows[0].count as number;
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
        [id, weddingId, `${input.labelPrefix} ${startIndex + i + 1}`, input.capacity, input.shape, x, y]
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
  const { rows } = await pool.query(
    `${SELECT_WITH_REQUIRED} WHERE t."weddingId" = $1 ORDER BY t.label`,
    [weddingId]
  );
  return rows;
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

export async function deleteSeatingTableForWedding(id: string, weddingId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return (rowCount ?? 0) > 0;
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

// FR-4.6: unmarking a table Accessible re-checks FR-0.1 for anyone currently seated there who
// requires an accessible table -- they become Needs Reassignment (rather than silently staying
// put) and the plan is marked incomplete until it's fixed. Marking a table Accessible again
// clears the flag for anyone it affected here (the constraint they were flagged for no longer
// applies), and the plan goes back to complete if nothing else is wrong. Scoped to only this
// table's assignments in the wedding's current plan version -- a table with no plan generated
// yet, or no affected guests, is simply a no-op.
export async function syncAccessibleTableReassignment(
  weddingId: string,
  tableId: string
): Promise<{ affectedGuestNames: string[] }> {
  const { rows: tableRows } = await pool.query(
    `SELECT "isAccessible" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2`,
    [tableId, weddingId]
  );
  const table = tableRows[0];
  if (!table) return { affectedGuestNames: [] };

  const { rows: planRows } = await pool.query(
    `SELECT id FROM "plan_versions" WHERE "weddingId" = $1 ORDER BY "versionNumber" DESC LIMIT 1`,
    [weddingId]
  );
  const currentPlanVersionId: string | undefined = planRows[0]?.id;
  if (!currentPlanVersionId) return { affectedGuestNames: [] };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Sync every assignment at this table to whether it *should* be flagged given the table's
    // current accessible state -- true only when the table is no longer accessible and the guest
    // needs one; false (cleared) otherwise, including when the table is accessible again.
    const { rows: affectedRows } = await client.query(
      `UPDATE "seat_assignments" sa
       SET "needsReassignment" = (NOT $1 AND g."requiresAccessibleTable"), "updatedAt" = now()
       FROM "guests" g
       WHERE sa."guestId" = g.id AND sa."planVersionId" = $2 AND sa."seatingTableId" = $3
         AND sa."needsReassignment" IS DISTINCT FROM (NOT $1 AND g."requiresAccessibleTable")
       RETURNING g.id, (g."firstName" || ' ' || g."lastName") AS name, sa."needsReassignment" AS "nowFlagged"`,
      [table.isAccessible, currentPlanVersionId, tableId]
    );

    const { rows: countRows } = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
            AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id)
         ) AS "unassignedCount",
         (SELECT COUNT(*)::int FROM "seat_assignments" WHERE "planVersionId" = $2 AND "needsReassignment" = true)
           AS "needsReassignmentCount"`,
      [weddingId, currentPlanVersionId]
    );
    const isComplete = countRows[0].unassignedCount === 0 && countRows[0].needsReassignmentCount === 0;
    await client.query(`UPDATE "plan_versions" SET "isComplete" = $1 WHERE id = $2`, [
      isComplete,
      currentPlanVersionId,
    ]);

    await client.query("COMMIT");
    return {
      affectedGuestNames: affectedRows.filter((r) => r.nowFlagged).map((r) => r.name as string),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
