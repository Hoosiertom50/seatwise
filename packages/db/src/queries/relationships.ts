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

  // TS-165: the checks and the insert run as one, with the pair locked -- two requests at once
  // (say "must sit together" and "must not sit together") used to both pass the checks, leaving
  // contradictory hard rules that made every Generate fail.
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`relationship:${weddingId}:${guestAId}:${guestBId}`]);

    // FR-0.1: a hard rule can never be left violated. Two guests can't simultaneously be
    // required to sit together and forbidden from sitting together — block that outright.
    const opposite = OPPOSITE_HARD_TYPE[input.type];
    if (opposite) {
      const { rows: conflicting } = await client.query(
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

    // TS-173: two guests who must sit together have to be on the same Restricted table's list (or
    // neither on one) -- otherwise one is required at a table the other isn't allowed at.
    if (input.type === "MUST_SIT_TOGETHER") {
      const { rows: lists } = await client.query(
        `SELECT g.id, (g."firstName" || ' ' || g."lastName") AS name, t.id AS "tableId", t.label AS "tableLabel"
         FROM "guests" g
         LEFT JOIN "restricted_table_guests" rtg ON rtg."guestId" = g.id
           AND EXISTS (SELECT 1 FROM "seating_tables" st WHERE st.id = rtg."tableId" AND st."isRestricted")
         LEFT JOIN "seating_tables" t ON t.id = rtg."tableId"
         WHERE g.id = ANY($1::text[]) AND g."weddingId" = $2`,
        [[guestAId, guestBId], weddingId]
      );
      const [a, b] = lists as { name: string; tableId: string | null; tableLabel: string | null }[];
      if (a && b && a.tableId !== b.tableId) {
        const [listed, other] = a.tableId ? [a, b] : [b, a];
        throw new RelationshipConflictError(
          other.tableId
            ? `${a.name} and ${b.name} are required at different Restricted tables, so they can't be required to sit together.`
            : `${listed.name} is required at "${listed.tableLabel}" and ${other.name} isn't on its list — add them to that list first, or they can't be required to sit together.`
        );
      }
    }

    const { rows: exact } = await client.query(
      `SELECT id FROM "guest_relationships"
       WHERE "weddingId" = $1 AND "guestAId" = $2 AND "guestBId" = $3 AND type = $4`,
      [weddingId, guestAId, guestBId, input.type]
    );
    if (exact.length > 0) {
      throw new RelationshipConflictError("That rule already exists for these two guests.");
    }

    await client.query(
      `INSERT INTO "guest_relationships" (id, "weddingId", "guestAId", "guestBId", type)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, weddingId, guestAId, guestBId, input.type]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // The database's own one-of-each-rule check, if a duplicate slipped in some other way.
    if ((err as { code?: string }).code === "23505") {
      throw new RelationshipConflictError("That rule already exists for these two guests.");
    }
    throw err;
  } finally {
    client.release();
  }

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

// TS-150: returns the two guests the rule was about (null if there was no such rule), so their
// seats can be re-checked -- a flag the rule caused clears once it's gone.
export async function deleteRelationshipForWedding(
  id: string,
  weddingId: string
): Promise<{ guestAId: string; guestBId: string } | null> {
  const { rows } = await pool.query(
    `DELETE FROM "guest_relationships" WHERE id = $1 AND "weddingId" = $2 RETURNING "guestAId", "guestBId"`,
    [id, weddingId]
  );
  return rows[0] ?? null;
}
