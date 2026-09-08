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
  // FR-3.4
  side: string;
  // FR-3.7
  ageCategory: string;
  // FR-3.7a: the Restricted table this guest is a required member of, if any.
  requiredTableId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Joined against restricted_table_guests so every read can surface requiredTableId (FR-3.7a)
// without a second round-trip; a plain INSERT ... RETURNING can't do that join, so createGuest
// below fills it in as null itself (a brand-new guest can't already be on a required list).
const COLUMNS = `g.id, g."weddingId", g."firstName", g."lastName", g."partyName", g.headcount, g.tier,
  g."rsvpStatus", g."requiresAccessibleTable", g."isLocked", g."dayOfAttendance", g.notes, g.side,
  g."ageCategory", rtg."tableId" AS "requiredTableId", g."createdAt", g."updatedAt"`;
const FROM_JOINED = `FROM "guests" g LEFT JOIN "restricted_table_guests" rtg ON rtg."guestId" = g.id`;

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
  side?: string;
  ageCategory?: string;
}

// NFR-9.3b: `notes` is where free-text dietary/accessibility details actually end up, so it's the
// one guest field encrypted at rest (see crypto.ts) — encrypted on the way in here, decrypted on
// the way back out in every read below.
export async function createGuest(weddingId: string, input: CreateGuestData): Promise<GuestRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "guests"
       (id, "weddingId", "firstName", "lastName", "partyName", headcount, tier, "rsvpStatus", "requiresAccessibleTable", "isLocked", "dayOfAttendance", notes, side, "ageCategory", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
     RETURNING id, "weddingId", "firstName", "lastName", "partyName", headcount, tier,
               "rsvpStatus", "requiresAccessibleTable", "isLocked", "dayOfAttendance", notes, side,
               "ageCategory", "createdAt", "updatedAt"`,
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
      input.side ?? "BOTH",
      input.ageCategory ?? "ADULT",
    ]
  );
  return { ...rows[0], notes: decryptText(rows[0].notes), requiredTableId: null };
}

export async function listGuestsByWedding(weddingId: string): Promise<GuestRow[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${FROM_JOINED} WHERE g."weddingId" = $1 ORDER BY g."lastName", g."firstName"`,
    [weddingId]
  );
  return rows.map((r) => ({ ...r, notes: decryptText(r.notes) }));
}

export async function getGuestForWedding(id: string, weddingId: string): Promise<GuestRow | null> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${FROM_JOINED} WHERE g.id = $1 AND g."weddingId" = $2`,
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
    side: `side`,
    ageCategory: `"ageCategory"`,
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
