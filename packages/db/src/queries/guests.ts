import { randomUUID } from "crypto";
import { pool } from "../pool";
import { encryptText, decryptText } from "../crypto";

export interface GuestRow {
  id: string;
  weddingId: string;
  firstName: string;
  lastName: string;
  partyName: string | null;
  headcount: number;
  tier: string;
  rsvpStatus: string;
  requiresAccessibleTable: boolean;
  isLocked: boolean;
  dayOfAttendance: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, "weddingId", "firstName", "lastName", "partyName", headcount, tier,
  "rsvpStatus", "requiresAccessibleTable", "isLocked", "dayOfAttendance", notes, "createdAt", "updatedAt"`;

export interface CreateGuestData {
  firstName: string;
  lastName: string;
  partyName?: string | null;
  headcount?: number;
  tier?: string;
  rsvpStatus?: string;
  requiresAccessibleTable?: boolean;
  isLocked?: boolean;
  dayOfAttendance?: string;
  notes?: string | null;
}

// NFR-9.3b: `notes` is where free-text dietary/accessibility details actually end up, so it's the
// one guest field encrypted at rest (see crypto.ts) — encrypted on the way in here, decrypted on
// the way back out in every read below.
export async function createGuest(weddingId: string, input: CreateGuestData): Promise<GuestRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "guests"
       (id, "weddingId", "firstName", "lastName", "partyName", headcount, tier, "rsvpStatus", "requiresAccessibleTable", "isLocked", "dayOfAttendance", notes, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     RETURNING ${COLUMNS}`,
    [
      id,
      weddingId,
      input.firstName,
      input.lastName,
      input.partyName ?? null,
      input.headcount ?? 1,
      input.tier ?? "OTHER",
      input.rsvpStatus ?? "PENDING",
      input.requiresAccessibleTable ?? false,
      input.isLocked ?? false,
      input.dayOfAttendance ?? "ATTENDING",
      encryptText(input.notes ?? null),
    ]
  );
  return { ...rows[0], notes: decryptText(rows[0].notes) };
}

export async function listGuestsByWedding(weddingId: string): Promise<GuestRow[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "guests" WHERE "weddingId" = $1 ORDER BY "lastName", "firstName"`,
    [weddingId]
  );
  return rows.map((r) => ({ ...r, notes: decryptText(r.notes) }));
}

export async function getGuestForWedding(id: string, weddingId: string): Promise<GuestRow | null> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  if (!rows[0]) return null;
  return { ...rows[0], notes: decryptText(rows[0].notes) };
}

export async function updateGuestForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateGuestData>
): Promise<boolean> {
  const columnMap: Record<string, string> = {
    firstName: `"firstName"`,
    lastName: `"lastName"`,
    partyName: `"partyName"`,
    headcount: `headcount`,
    tier: `tier`,
    rsvpStatus: `"rsvpStatus"`,
    requiresAccessibleTable: `"requiresAccessibleTable"`,
    isLocked: `"isLocked"`,
    dayOfAttendance: `"dayOfAttendance"`,
    notes: `notes`,
  };
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, column] of Object.entries(columnMap)) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) {
      fields.push(`${column} = $${i++}`);
      values.push(key === "notes" ? encryptText(value as string | null) : value);
    }
  }
  if (fields.length === 0) return true;
  fields.push(`"updatedAt" = now()`);
  values.push(id, weddingId);
  const { rowCount } = await pool.query(
    `UPDATE "guests" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
    values
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteGuestForWedding(id: string, weddingId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return (rowCount ?? 0) > 0;
}
