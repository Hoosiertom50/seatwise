import { randomUUID } from "crypto";
import { pool } from "../pool";

// TS-18 (FR-13.1/FR-13.2): a per-wedding, chronological run-of-show -- its own record, entirely
// independent of guests/tables/rules/seating plans. Always listed by (time, sortOrder): time is
// the plain "always chronological" ordering FR-13.1 asks for, and sortOrder only ever breaks ties
// between entries that share the exact same time (see reorderTimelineEntry below).

export interface TimelineEntryRow {
  id: string;
  weddingId: string;
  time: string;
  description: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, "weddingId", time, description, "sortOrder", "createdAt", "updatedAt"`;

export async function listTimelineEntriesForWedding(weddingId: string): Promise<TimelineEntryRow[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "timeline_entries" WHERE "weddingId" = $1 ORDER BY time ASC, "sortOrder" ASC`,
    [weddingId]
  );
  return rows;
}

export async function getTimelineEntryForWedding(id: string, weddingId: string): Promise<TimelineEntryRow | null> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return rows[0] ?? null;
}

export interface CreateTimelineEntryData {
  time: string;
  description: string;
}

// FR-13.1: a brand-new entry is appended after any existing entries that already share its exact
// time, rather than defaulting to 0 and landing arbitrarily among them.
export async function createTimelineEntry(
  weddingId: string,
  input: CreateTimelineEntryData
): Promise<TimelineEntryRow> {
  const id = randomUUID();
  const { rows: maxRows } = await pool.query(
    `SELECT COALESCE(MAX("sortOrder"), -1) AS "maxSortOrder" FROM "timeline_entries" WHERE "weddingId" = $1 AND time = $2`,
    [weddingId, input.time]
  );
  const sortOrder = maxRows[0].maxSortOrder + 1;

  const { rows } = await pool.query(
    `INSERT INTO "timeline_entries" (id, "weddingId", time, description, "sortOrder", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING ${COLUMNS}`,
    [id, weddingId, input.time, input.description, sortOrder]
  );
  return rows[0];
}

export async function updateTimelineEntry(
  id: string,
  weddingId: string,
  input: Partial<CreateTimelineEntryData>
): Promise<TimelineEntryRow | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.time !== undefined) {
    fields.push(`time = $${i++}`);
    values.push(input.time);
  }
  if (input.description !== undefined) {
    fields.push(`description = $${i++}`);
    values.push(input.description);
  }
  if (fields.length === 0) return getTimelineEntryForWedding(id, weddingId);

  fields.push(`"updatedAt" = now()`);
  values.push(id, weddingId);
  const { rows } = await pool.query(
    `UPDATE "timeline_entries" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}
     RETURNING ${COLUMNS}`,
    values
  );
  return rows[0] ?? null;
}

export async function deleteTimelineEntry(id: string, weddingId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "timeline_entries" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return (rowCount ?? 0) > 0;
}

// FR-13.2: "reordered" -- swaps this entry's sortOrder with whichever neighbor sharing its exact
// same `time` sits immediately UP (earlier) or DOWN (later) in that tied group. A no-op (returns
// the entry unchanged) if there's no such neighbor -- already first/last within its time group.
export async function reorderTimelineEntry(
  id: string,
  weddingId: string,
  direction: "UP" | "DOWN"
): Promise<TimelineEntryRow | null> {
  const entry = await getTimelineEntryForWedding(id, weddingId);
  if (!entry) return null;

  const { rows: neighborRows } = await pool.query(
    direction === "UP"
      ? `SELECT id, "sortOrder" FROM "timeline_entries"
         WHERE "weddingId" = $1 AND time = $2 AND "sortOrder" < $3
         ORDER BY "sortOrder" DESC LIMIT 1`
      : `SELECT id, "sortOrder" FROM "timeline_entries"
         WHERE "weddingId" = $1 AND time = $2 AND "sortOrder" > $3
         ORDER BY "sortOrder" ASC LIMIT 1`,
    [weddingId, entry.time, entry.sortOrder]
  );
  const neighbor = neighborRows[0];
  if (!neighbor) return entry;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE "timeline_entries" SET "sortOrder" = $1, "updatedAt" = now() WHERE id = $2`, [
      neighbor.sortOrder,
      entry.id,
    ]);
    await client.query(`UPDATE "timeline_entries" SET "sortOrder" = $1, "updatedAt" = now() WHERE id = $2`, [
      entry.sortOrder,
      neighbor.id,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getTimelineEntryForWedding(id, weddingId);
}
