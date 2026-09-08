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
  // FR-7.7: an optimistic-concurrency counter for this guest -- an edit that names an
  // expectedRevision the server no longer matches is rejected as stale.
  revision: number;
}

// Joined against restricted_table_guests so every read can surface requiredTableId (FR-3.7a)
// without a second round-trip; a plain INSERT ... RETURNING can't do that join, so createGuest
// below fills it in as null itself (a brand-new guest can't already be on a required list).
const COLUMNS = `g.id, g."weddingId", g."firstName", g."lastName", g."partyName", g.headcount, g.tier,
  g."rsvpStatus", g."requiresAccessibleTable", g."isLocked", g."dayOfAttendance", g.notes, g.side,
  g."ageCategory", g.revision, rtg."tableId" AS "requiredTableId", g."createdAt", g."updatedAt"`;
const FROM_JOINED = `FROM "guests" g LEFT JOIN "restricted_table_guests" rtg ON rtg."guestId" = g.id`;

// FR-7.7: thrown instead of applying an edit whose expectedRevision no longer matches the guest's
// current one -- the fresh, up-to-date guest is attached so the caller can refresh the UI with it
// directly rather than making a second round-trip.
export class GuestConflictError extends Error {
  guest: GuestRow;
  constructor(message: string, guest: GuestRow) {
    super(message);
    this.guest = guest;
  }
}

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
               "ageCategory", revision, "createdAt", "updatedAt"`,
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

// FR-7.7, extended to guests: an optional expectedRevision locks the guest's row (FOR UPDATE,
// inside this function's own transaction) and compares it against the current revision before
// writing anything. A mismatch means someone else's edit landed first -- rather than proceeding
// on stale data, this throws GuestConflictError with the fresh, currently-committed guest attached
// (a plain read from a second connection isn't blocked by the row lock, so it safely sees the
// latest committed state) and writes nothing. A caller that passes no expectedRevision at all
// (an internal/legacy call site) skips the check entirely, matching the plan-version pattern.
export async function updateGuestForWedding(
  id: string,
  weddingId: string,
  input: Partial<CreateGuestData>,
  expectedRevision?: number
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT revision FROM "guests" WHERE id = $1 AND "weddingId" = $2 FOR UPDATE`,
      [id, weddingId]
    );
    const current = rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return false;
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      const fresh = await getGuestForWedding(id, weddingId);
      throw new GuestConflictError(
        "This guest changed since you loaded them — someone else's edit landed first. It's been refreshed with the latest — please try again.",
        fresh!
      );
    }
    if (fields.length > 0) {
      fields.push(`"updatedAt" = now()`, `revision = revision + 1`);
      values.push(id, weddingId);
      await client.query(
        `UPDATE "guests" SET ${fields.join(", ")} WHERE id = $${i++} AND "weddingId" = $${i}`,
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

export async function deleteGuestForWedding(id: string, weddingId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "guests" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return (rowCount ?? 0) > 0;
}
