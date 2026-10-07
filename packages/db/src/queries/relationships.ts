import { randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";
import { lockCurrentPlan, lockRestrictedLists, waitForAnyFirstPlan } from "./seat-checks";
import { inWeddingChange, lockWeddingRow, recheckActorAccess, type ActorAccess } from "./wedding-lock";
import { assertWeddingHasRoom } from "./wedding-caps";

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

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

async function guestNames(q: Queryable, ids: string[]): Promise<Map<string, string>> {
  const { rows } = await q.query(
    `SELECT id, ("firstName" || ' ' || "lastName") AS name FROM "guests" WHERE id = ANY($1::text[])`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id as string, r.name as string]));
}

// TS-181: with `added` in place, is there a "must not sit together" pair inside one group of guests
// linked by "must sit together" rules (who always share a table)? Only the group the new rule
// touches is looked at, so an old problem elsewhere doesn't block an unrelated rule. Returns a
// plain-English reason naming the guests and the chain that links them, or null.
async function findRuleChainConflict(
  q: Queryable,
  weddingId: string,
  added: { guestAId: string; guestBId: string; type: "MUST_SIT_TOGETHER" | "MUST_NOT_SIT_TOGETHER" }
): Promise<string | null> {
  const { rows } = await q.query(
    `SELECT "guestAId", "guestBId", type FROM "guest_relationships"
     WHERE "weddingId" = $1 AND type IN ('MUST_SIT_TOGETHER', 'MUST_NOT_SIT_TOGETHER')`,
    [weddingId]
  );
  const rules = [...(rows as { guestAId: string; guestBId: string; type: string }[]), added];
  const together = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!together.has(a)) together.set(a, new Set());
    together.get(a)!.add(b);
  };
  for (const r of rules) {
    if (r.type !== "MUST_SIT_TOGETHER") continue;
    link(r.guestAId, r.guestBId);
    link(r.guestBId, r.guestAId);
  }
  // The chain of "must sit together" rules from one guest to another (shortest), or null if none.
  const chain = (from: string, to: string): string[] | null => {
    const previous = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    while (queue.length > 0) {
      const at = queue.shift()!;
      if (at === to) {
        const path: string[] = [];
        for (let step: string | null = to; step !== null; step = previous.get(step) ?? null) path.unshift(step);
        return path;
      }
      for (const next of together.get(at) ?? []) {
        if (!previous.has(next)) {
          previous.set(next, at);
          queue.push(next);
        }
      }
    }
    return null;
  };
  // Everyone in the new rule's group (for a must-not rule, its two guests are the pair to check).
  const pairs =
    added.type === "MUST_NOT_SIT_TOGETHER"
      ? [added]
      : rules.filter((r) => r.type === "MUST_NOT_SIT_TOGETHER");
  for (const pair of pairs) {
    const path = chain(pair.guestAId, pair.guestBId);
    if (!path) continue;
    // A must-sit rule only matters if the chain runs through the new rule's guests.
    if (added.type === "MUST_SIT_TOGETHER" && !(path.includes(added.guestAId) && path.includes(added.guestBId))) {
      continue;
    }
    const names = await guestNames(q, path);
    const named = path.map((id) => names.get(id) ?? "a guest");
    return (
      `${named[0]} and ${named[named.length - 1]} must not sit together, but "must sit together" rules ` +
      `(${named.join(" → ")}) would always seat them at the same table. Remove one of those rules first.`
    );
  }
  return null;
}

export async function createRelationship(
  weddingId: string,
  input: { guestAId: string; guestBId: string; type: RelationshipType },
  /** TS-204: the access the request was let in with -- read again under the wedding's lock. */
  actor?: ActorAccess
): Promise<RelationshipRow> {
  if (input.guestAId === input.guestBId) {
    throw new RelationshipConflictError("A guest can't have a relationship with themselves.");
  }
  const [guestAId, guestBId] = normalizePair(input.guestAId, input.guestBId);

  // TS-165: the checks and the insert run as one, with the pair locked -- two requests at once
  // (say "must sit together" and "must not sit together") used to both pass the checks, leaving
  // contradictory hard rules that made every Generate fail.
  const id = randomUUID();
  let created: RelationshipRow | null = null;
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    // TS-181: the current plan's row (see lockCurrentPlan), then the lists -- the same locks a
    // Restricted table's list save takes -- so a new rule and a new list can't each pass their
    // checks against the other's old state. That also puts two new rules for the same wedding
    // one after the other, so the rule-chain check below always sees every other rule.
    // TS-205: the wedding's lock before them (the usual order), so the cap below counts rules
    // added at the same moment in turn; TS-204: then the person's access, read again.
    await lockWeddingRow(client, weddingId);
    if (actor) await recheckActorAccess(client, weddingId, actor);
    await lockCurrentPlan(client, weddingId);
    await lockRestrictedLists(client, weddingId);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`relationship:${weddingId}:${guestAId}:${guestBId}`]);
    await assertWeddingHasRoom(client, weddingId, "relationships", 1);

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

    // TS-181: two guests who must not sit together can't both be required at the same Restricted
    // table -- one of them would have nowhere they're allowed to sit.
    if (input.type === "MUST_NOT_SIT_TOGETHER") {
      const { rows: sameList } = await client.query(
        `SELECT t.label FROM "restricted_table_guests" ra
         JOIN "restricted_table_guests" rb ON rb."tableId" = ra."tableId"
         JOIN "seating_tables" t ON t.id = ra."tableId"
         WHERE ra."guestId" = $1 AND rb."guestId" = $2 AND t."isRestricted"
         LIMIT 1`,
        [guestAId, guestBId]
      );
      if (sameList[0]) {
        const names = await guestNames(client, [guestAId, guestBId]);
        throw new RelationshipConflictError(
          `${names.get(guestAId)} and ${names.get(guestBId)} are both on "${sameList[0].label}"'s required-guest list, so they can't have a "must not sit together" rule. Take one of them off that list first.`
        );
      }
    }

    // TS-181: a rule that would contradict a chain of rules. Guests linked by "must sit together"
    // rules (directly or through others) all share one table, so a "must not sit together" rule
    // between any two of them can never be kept -- and every Generate would fail. Before, only the
    // same two guests' opposite rule was caught.
    if (input.type === "MUST_SIT_TOGETHER" || input.type === "MUST_NOT_SIT_TOGETHER") {
      const chainConflict = await findRuleChainConflict(client, weddingId, { guestAId, guestBId, type: input.type });
      if (chainConflict) throw new RelationshipConflictError(chainConflict);
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
    // TS-209: read back in the same transaction -- read after it, a failure answered an error for a
    // rule that was saved.
    created = await getRelationshipById(id, weddingId, client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // The database's own one-of-each-rule check, if a duplicate slipped in some other way.
    if ((err as { code?: string }).code === "23505") {
      throw new RelationshipConflictError("That rule already exists for these two guests.");
    }
    throw err;
  } finally {
    client.release();
  }

  // It was just inserted in this transaction, so it's there.
  return created!;
}

async function getRelationshipById(
  id: string,
  weddingId: string,
  db: typeof pool | import("pg").PoolClient = pool
): Promise<RelationshipRow | null> {
  const { rows } = await db.query(
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
  weddingId: string,
  /** TS-204: the access the request was let in with -- read again as the rule is removed. */
  actor?: ActorAccess
): Promise<{ guestAId: string; guestBId: string } | null> {
  // TS-234: when there's no current plan yet, the wedding's lock first, so a rule removed during
  // a first Generate waits for the new plan, and the re-check that follows (resyncGuestsSeats)
  // sees it -- before, the removal went ahead and the new plan kept the old rule's flags. With a
  // plan, the removal itself needs no plan lock (the re-check after it takes one). Then the
  // person's access, read again, as everywhere else.
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await waitForAnyFirstPlan(client, weddingId);
    if (actor) await recheckActorAccess(client, weddingId, actor);
    const { rows } = await client.query(
      `DELETE FROM "guest_relationships" WHERE id = $1 AND "weddingId" = $2 RETURNING "guestAId", "guestBId"`,
      [id, weddingId]
    );
    await client.query("COMMIT");
    return (rows[0] as { guestAId: string; guestBId: string } | undefined) ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
