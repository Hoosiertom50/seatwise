import { randomUUID } from "crypto";
import { pool } from "../pool";

export interface WeddingRow {
  id: string;
  ownerId: string;
  name: string;
  eventDate: string | null;
  venueName: string | null;
  status: string;
  guestCount: number;
  emailNotificationsEnabled: boolean;
  // FR-3.4
  sideMixing: string;
  // FR-1.3a
  sideLabel1: string;
  sideLabel2: string;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_WITH_GUEST_COUNT = `
  SELECT w.id, w."ownerId", w.name, w."eventDate"::text AS "eventDate", w."venueName", w.status,
         w."emailNotificationsEnabled", w."sideMixing", w."sideLabel1", w."sideLabel2",
         w."createdAt", w."updatedAt",
         COALESCE(g.count, 0)::int AS "guestCount"
  FROM "weddings" w
  LEFT JOIN (
    SELECT "weddingId", COUNT(*) AS count FROM "guests" GROUP BY "weddingId"
  ) g ON g."weddingId" = w.id
`;

export async function createWedding(
  ownerId: string,
  input: {
    name: string;
    eventDate?: string | null;
    venueName?: string | null;
    sideMixing?: string;
    sideLabel1?: string;
    sideLabel2?: string;
  }
): Promise<WeddingRow> {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO "weddings" (id, "ownerId", name, "eventDate", "venueName", "sideMixing", "sideLabel1", "sideLabel2", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::"SideMixingSetting", 'BALANCED_MIX'), COALESCE($7, 'Bride'), COALESCE($8, 'Groom'), now())
     RETURNING id, "ownerId", name, "eventDate"::text AS "eventDate", "venueName", status,
               "emailNotificationsEnabled", "sideMixing", "sideLabel1", "sideLabel2", "createdAt", "updatedAt"`,
    [
      id,
      ownerId,
      input.name,
      input.eventDate ?? null,
      input.venueName ?? null,
      input.sideMixing ?? null,
      input.sideLabel1 ?? null,
      input.sideLabel2 ?? null,
    ]
  );
  return { ...rows[0], guestCount: 0 };
}

export async function listWeddingsByOwner(ownerId: string): Promise<WeddingRow[]> {
  const { rows } = await pool.query(
    `${SELECT_WITH_GUEST_COUNT} WHERE w."ownerId" = $1 ORDER BY w."createdAt" DESC`,
    [ownerId]
  );
  return rows;
}

export async function getWeddingForOwner(id: string, ownerId: string): Promise<WeddingRow | null> {
  const { rows } = await pool.query(
    `${SELECT_WITH_GUEST_COUNT} WHERE w.id = $1 AND w."ownerId" = $2`,
    [id, ownerId]
  );
  return rows[0] ?? null;
}

// TS-13: unlike getWeddingForOwner, this doesn't check ownership — callers pair it with
// getWeddingAccessLevel() so a View/Comment/Edit collaborator (not just the owner) can load it.
export async function getWeddingById(id: string): Promise<WeddingRow | null> {
  const { rows } = await pool.query(`${SELECT_WITH_GUEST_COUNT} WHERE w.id = $1`, [id]);
  return rows[0] ?? null;
}

// TS-13: the dashboard's "your weddings" list needs to include weddings a user has been given
// collaborator access to, not only ones they own.
export async function listWeddingsAccessibleToUser(userId: string): Promise<WeddingRow[]> {
  const { rows } = await pool.query(
    `${SELECT_WITH_GUEST_COUNT}
     WHERE w."ownerId" = $1
        OR w.id IN (SELECT "weddingId" FROM "wedding_collaborators" WHERE "userId" = $1)
     ORDER BY w."createdAt" DESC`,
    [userId]
  );
  return rows;
}

export async function setEmailNotificationsEnabled(id: string, ownerId: string, enabled: boolean): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE "weddings" SET "emailNotificationsEnabled" = $1, "updatedAt" = now() WHERE id = $2 AND "ownerId" = $3`,
    [enabled, id, ownerId]
  );
  return (rowCount ?? 0) > 0;
}

export async function updateWeddingForOwner(
  id: string,
  ownerId: string,
  input: Partial<{
    name: string;
    eventDate: string | null;
    venueName: string | null;
    sideMixing: string;
    sideLabel1: string;
    sideLabel2: string;
  }>
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(input.name);
  }
  if (input.eventDate !== undefined) {
    fields.push(`"eventDate" = $${i++}`);
    values.push(input.eventDate);
  }
  if (input.venueName !== undefined) {
    fields.push(`"venueName" = $${i++}`);
    values.push(input.venueName);
  }
  if (input.sideMixing !== undefined) {
    fields.push(`"sideMixing" = $${i++}::"SideMixingSetting"`);
    values.push(input.sideMixing);
  }
  // FR-1.3a: a pure label rename -- never touches guests."side", any rule, or any assignment.
  if (input.sideLabel1 !== undefined) {
    fields.push(`"sideLabel1" = $${i++}`);
    values.push(input.sideLabel1);
  }
  if (input.sideLabel2 !== undefined) {
    fields.push(`"sideLabel2" = $${i++}`);
    values.push(input.sideLabel2);
  }
  fields.push(`"updatedAt" = now()`);
  values.push(id, ownerId);
  const { rowCount } = await pool.query(
    `UPDATE "weddings" SET ${fields.join(", ")} WHERE id = $${i++} AND "ownerId" = $${i}`,
    values
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteWeddingForOwner(id: string, ownerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "weddings" WHERE id = $1 AND "ownerId" = $2`,
    [id, ownerId]
  );
  return (rowCount ?? 0) > 0;
}
