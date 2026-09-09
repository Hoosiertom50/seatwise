import { randomUUID } from "crypto";
import { pool } from "../pool";

export type RelationshipType =
  | "MUST_SIT_TOGETHER"
  | "MUST_NOT_SIT_TOGETHER"
  | "PREFER_NEAR"
  | "AVOID";

const HARD_TYPES: RelationshipType[] = ["MUST_SIT_TOGETHER", "MUST_NOT_SIT_TOGETHER"];

// Every relationship type here is symmetric ("A and B must sit together" reads the same
// either direction), so we always store the pair in a canonical order. That's what lets a
// single unique index catch duplicates regardless of which guest the caller passed as A vs B.
function normalizePair(guestAId: string, guestBId: string): [string, string] {
  return guestAId < guestBId ? [guestAId, guestBId] : [guestBId, guestAId];
}

export interface RelationshipRow {
  id: string;
  weddingId: string;
  guestAId: string;
  guestBId: string;
  type: RelationshipType;
  createdAt: Date;
  guestAName: string;
  guestBName: string;
}

const OPPOSITE_HARD_TYPE: Partial<Record<RelationshipType, RelationshipType>> = {
  MUST_SIT_TOGETHER: "MUST_NOT_SIT_TOGETHER",
  MUST_NOT_SIT_TOGETHER: "MUST_SIT_TOGETHER",
};

export class RelationshipConflictError extends Error {}

export async function createRelationship(
  weddingId: string,
  input: { guestAId: string; guestBId: string; type: RelationshipType }
): Promise<RelationshipRow> {
  if (input.guestAId === input.guestBId) {
    throw new RelationshipConflictError("A guest can't have a relationship with themselves.");
  }
  const [guestAId, guestBId] = normalizePair(input.guestAId, input.guestBId);

  // FR-0.1: a hard rule can never be left violated. Two guests can't simultaneously be
  // required to sit together and forbidden from sitting together — block that outright.
  const opposite = OPPOSITE_HARD_TYPE[input.type];
  if (opposite) {
    const { rows: conflicting } = await pool.query(
      `SELECT id FROM "guest_relationships"
       WHERE "weddingId" = $1 AND "guestAId" = $2 AND "guestBId" = $3 AND type = $4`,
      [weddingId, guestAId, guestBId, opposite]
    );
    if (conflicting.length > 0) {
      throw new RelationshipConflictError(
        `These two guests already have a conflicting rule (${opposite.replace(/_/g, " ").toLowerCase()}). Remove that one first.`
      );
    }
  }

  const { rows: exact } = await pool.query(
    `SELECT id FROM "guest_relationships"
     WHERE "weddingId" = $1 AND "guestAId" = $2 AND "guestBId" = $3 AND type = $4`,
    [weddingId, guestAId, guestBId, input.type]
  );
  if (exact.length > 0) {
    throw new RelationshipConflictError("That rule already exists for these two guests.");
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO "guest_relationships" (id, "weddingId", "guestAId", "guestBId", type)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, weddingId, guestAId, guestBId, input.type]
  );

  const created = await getRelationshipById(id, weddingId);
  if (!created) throw new Error("Failed to load relationship after creating it");
  return created;
}

async function getRelationshipById(id: string, weddingId: string): Promise<RelationshipRow | null> {
  const { rows } = await pool.query(
    `SELECT r.id, r."weddingId", r."guestAId", r."guestBId", r.type, r."createdAt",
            (ga."firstName" || ' ' || ga."lastName") AS "guestAName",
            (gb."firstName" || ' ' || gb."lastName") AS "guestBName"
     FROM "guest_relationships" r
     JOIN "guests" ga ON ga.id = r."guestAId"
     JOIN "guests" gb ON gb.id = r."guestBId"
     WHERE r.id = $1 AND r."weddingId" = $2`,
    [id, weddingId]
  );
  return rows[0] ?? null;
}

export async function listRelationshipsForWedding(weddingId: string): Promise<RelationshipRow[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r."weddingId", r."guestAId", r."guestBId", r.type, r."createdAt",
            (ga."firstName" || ' ' || ga."lastName") AS "guestAName",
            (gb."firstName" || ' ' || gb."lastName") AS "guestBName"
     FROM "guest_relationships" r
     JOIN "guests" ga ON ga.id = r."guestAId"
     JOIN "guests" gb ON gb.id = r."guestBId"
     WHERE r."weddingId" = $1
     ORDER BY r."createdAt" DESC`,
    [weddingId]
  );
  return rows;
}

export async function deleteRelationshipForWedding(id: string, weddingId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM "guest_relationships" WHERE id = $1 AND "weddingId" = $2`,
    [id, weddingId]
  );
  return (rowCount ?? 0) > 0;
}
