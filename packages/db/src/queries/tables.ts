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
  // FR-3.4
  singleSideOnly: boolean;
  // FR-3.7a: only ever populated for a Restricted table.
  requiredGuestIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose, "singleSideOnly", "createdAt", "updatedAt"`;

// Every read joins in the current required-guest list (FR-3.7a) as an aggregated array, so
// callers never need a second round-trip just to show a Restricted table's list.
const SELECT_WITH_REQUIRED = `
  SELECT t.id, t."weddingId", t.label, t.capacity, t."isRestricted", t."isAccessible", t."isLocked",
         t.purpose, t."singleSideOnly", t."createdAt", t."updatedAt",
         COALESCE(rtg."guestIds", ARRAY[]::text[]) AS "requiredGuestIds"
  FROM "seating_tables" t
  LEFT JOIN (
    SELECT "tableId", array_agg("guestId") AS "guestIds" FROM "restricted_table_guests" GROUP BY "tableId"
  ) rtg ON rtg."tableId" = t.id
`;

export interface CreateSeatingTableData {
  label: string;
  capacity: number;
  isRestricted?: boolean;
  isAccessible?: boolean;
  isLocked?: boolean;
  purpose?: string | null;
  singleSideOnly?: boolean;
}

export class RestrictedTableError extends Error {}

export async function createSeatingTable(
  weddingId: string,
  input: CreateSeatingTableData
): Promise<SeatingTableRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "seating_tables" (id, "weddingId", label, capacity, "isRestricted", "isAccessible", "isLocked", purpose, "singleSideOnly", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     RETURNING ${COLUMNS}`,
    [
      id,
      weddingId,
      input.label,
      input.capacity,
      input.isRestricted ?? false,
      input.isAccessible ?? false,
      input.isLocked ?? false,
      input.purpose ?? null,
      input.singleSideOnly ?? false,
    ]
  );
  return { ...rows[0], requiredGuestIds: [] };
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

export async function updateSeatingTableForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateSeatingTableData>
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
  if (input.singleSideOnly !== undefined) {
    fields.push(`"singleSideOnly" = $${i++}`);
    values.push(input.singleSideOnly);
  }
  if (fields.length === 0) return true;
  fields.push(`"updatedAt" = now()`);
  values.push(id, weddingId);
  const { rowCount } = await pool.query(
    `UPDATE "seating_tables" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
    values
  );
  return (rowCount ?? 0) > 0;
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
