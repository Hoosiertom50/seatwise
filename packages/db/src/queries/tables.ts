import { randomUUID } from "crypto";
import { pool } from "../pool";

export interface SeatingTableRow {
  id: string;
  weddingId: string;
  label: string;
  capacity: number;
  isRestricted: boolean;
  purpose: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, "weddingId", label, capacity, "isRestricted", purpose, "createdAt", "updatedAt"`;

export interface CreateSeatingTableData {
  label: string;
  capacity: number;
  isRestricted?: boolean;
  purpose?: string | null;
}

export async function createSeatingTable(
  weddingId: string,
  input: CreateSeatingTableData
): Promise<SeatingTableRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "seating_tables" (id, "weddingId", label, capacity, "isRestricted", purpose, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING ${COLUMNS}`,
    [id, weddingId, input.label, input.capacity, input.isRestricted ?? false, input.purpose ?? null]
  );
  return rows[0];
}

export async function listSeatingTablesForWedding(weddingId: string): Promise<SeatingTableRow[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "seating_tables" WHERE "weddingId" = $1 ORDER BY label`,
    [weddingId]
  );
  return rows;
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
  if (input.purpose !== undefined) {
    fields.push(`purpose = $${i++}`);
    values.push(input.purpose);
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
