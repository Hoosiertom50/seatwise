// TS-259: unit tests for the table re-check (resyncTables in packages/db/src/queries/seat-checks.ts)
// running in a fixed number of queries -- it used to be three per table plus three per seated guest,
// about 6,800 for Generate or Approve on a 2,000-guest wedding.
//   1. Scripted stand-in database (always runs): the re-check is 2 queries (+1 UPDATE when a flag
//      changes) whether a table has 3 guests or 300, takes its locks tables-then-seats, and keeps
//      the capacity walk and the flag reasons.
//   2. Local database (runs only when the database in packages/db/.env, or DATABASE_URL, is on this
//      machine and reachable -- skipped otherwise, e.g. in CI's unit job, which has no Postgres):
//      random small weddings are built inside one transaction that is always rolled back, and the
//      new re-check's flags, reasons and order are compared with the old one's (kept below as a
//      reference copy), case by case. Never connects anywhere but localhost.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

const db = await import("@seatwise/db");
const { resyncTables, resyncSeatsAtTable, SEAT_ORDER } = db;

type Rows = Record<string, unknown>[];
type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Rows; rowCount?: number | null }> };
type Result = Awaited<ReturnType<typeof resyncTables>>;

// ---- 1. Scripted stand-in --------------------------------------------------------------------------

const TABLE_LOCK = /FROM "seating_tables"\s+WHERE id = ANY\(\$1::text\[\]\) AND "weddingId" = \$2\s+ORDER BY id COLLATE "C"\s+FOR NO KEY UPDATE/;
const SEAT_LOCK = /FROM "seat_assignments" sa[\s\S]*ORDER BY sa\."seatingTableId" COLLATE "C", [\s\S]*FOR NO KEY UPDATE OF sa$/;
const FLAG_UPDATE = /^UPDATE "seat_assignments" sa SET "needsReassignment" = v\.flag[\s\S]*unnest\(\$1::text\[\], \$2::boolean\[\]\)/;

interface ScriptedSeat {
  id: string;
  guestId: string;
  tableId: string;
  name: string;
  headcount: number;
  needsReassignment: boolean;
  accessibleBroken: boolean;
  restrictedBroken: boolean;
  otherBroken: boolean;
}

/** A stand-in client: answers the table lock and the seat read with these rows, records every statement. */
function scripted(tables: Rows, seats: ScriptedSeat[]) {
  const log: { sql: string; params: unknown[] }[] = [];
  const client: Queryable = {
    query: async (sql, params = []) => {
      const text = sql.replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });
      if (TABLE_LOCK.test(text)) return { rows: tables };
      if (SEAT_LOCK.test(text)) return { rows: seats as unknown as Rows };
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, log };
}

function seat(tableId: string, n: number, over: Partial<ScriptedSeat> = {}): ScriptedSeat {
  return {
    id: `s-${tableId}-${n}`,
    guestId: `g-${tableId}-${n}`,
    tableId,
    name: `Guest ${n}`,
    headcount: 1,
    needsReassignment: false,
    accessibleBroken: false,
    restrictedBroken: false,
    otherBroken: false,
    ...over,
  };
}

test("TS-259: re-checking no tables asks the database nothing", async () => {
  const { client, log } = scripted([], []);
  assert.deepEqual(await resyncTables(client as never, "w1", "p1", []), { newlyFlagged: [], changed: false });
  assert.equal(log.length, 0);
});

test("TS-259: the number of queries doesn't grow with the number of guests or tables", async () => {
  for (const [tableCount, perTable] of [
    [1, 3],
    [3, 10],
    [300, 7],
  ]) {
    const tables = Array.from({ length: tableCount }, (_, i) => ({ id: `t${String(i).padStart(3, "0")}`, capacity: 5, isRestricted: false, isAccessible: true }));
    const seats = tables.flatMap((t) => Array.from({ length: perTable }, (_, n) => seat(t.id as string, n)));
    // Every table seats more than its 5 seats: the extra guests are flagged, in one UPDATE.
    const { client, log } = scripted(tables, seats);
    const result = await resyncTables(client as never, "w1", "p1", tables.map((t) => t.id as string));
    assert.equal(log.length, perTable > 5 ? 3 : 2, `${tableCount} tables x ${perTable}: ${log.map((l) => l.sql.slice(0, 60)).join(" | ")}`);
    assert.equal(result.newlyFlagged.length, tableCount * Math.max(0, perTable - 5));
    assert.equal(result.changed, perTable > 5);

    // Nothing changes when the flags already match: just the two reads.
    const settled = seats.map((s, i) => ({ ...s, needsReassignment: i % perTable >= 5 }));
    const again = scripted(tables, settled);
    assert.deepEqual(await resyncTables(again.client as never, "w1", "p1", tables.map((t) => t.id as string)), { newlyFlagged: [], changed: false });
    assert.equal(again.log.length, 2);
  }
});

test("TS-259: tables are locked (all of them, by id) before any seat, and the flags are written last", async () => {
  const tables = [
    { id: "a", capacity: 1, isRestricted: false, isAccessible: true },
    { id: "b", capacity: 1, isRestricted: false, isAccessible: true },
  ];
  const { client, log } = scripted(tables, [seat("a", 1), seat("a", 2), seat("b", 1)]);
  await resyncTables(client as never, "w1", "p1", ["b", "a", "b"]);
  assert.match(log[0].sql, TABLE_LOCK);
  assert.deepEqual(log[0].params, [["b", "a"], "w1"], "each table once");
  assert.match(log[1].sql, SEAT_LOCK);
  assert.ok(log[1].sql.includes(SEAT_ORDER), "seats are counted in SEAT_ORDER within each table");
  assert.deepEqual(log[1].params, ["p1", ["a", "b"], "w1"], "only the tables that were found (and locked)");
  assert.match(log[2].sql, FLAG_UPDATE);
  assert.deepEqual(log[2].params, [["s-a-2"], [true]]);
});

test("TS-259: a table that isn't the wedding's (or is gone) is skipped without reading seats", async () => {
  const { client, log } = scripted([], [seat("x", 1)]);
  assert.deepEqual(await resyncSeatsAtTable(client as never, "w1", "p1", "x"), { newlyFlagged: [], changed: false });
  assert.equal(log.length, 1);
});

test("TS-259: the capacity walk and the reasons are the same as before", async () => {
  const tables = [{ id: "t1", capacity: 4, isRestricted: true, isAccessible: false }];
  const seats = [
    seat("t1", 1, { headcount: 2 }), // fits (2 of 4)
    seat("t1", 2, { headcount: 3, accessibleBroken: true, restrictedBroken: true }), // a rule: "accessible" wins, takes no seat
    seat("t1", 3, { headcount: 1, restrictedBroken: true }), // "restricted"
    seat("t1", 4, { headcount: 1, otherBroken: true, needsReassignment: true }), // still flagged: unchanged, not "newly"
    seat("t1", 5, { headcount: 3 }), // 2 + 3 > 4: "capacity"
    seat("t1", 6, { headcount: 2, needsReassignment: true }), // 2 + 2 = 4: fits, so it's cleared
    seat("t1", 7, { headcount: 1, otherBroken: true }), // "rule"
  ];
  const { client, log } = scripted(tables, seats);
  const result = await resyncTables(client as never, "w1", "p1", ["t1"]);
  assert.deepEqual(
    result.newlyFlagged.map((f) => [f.guestId, f.reason, f.tableId]),
    [
      ["g-t1-2", "accessible", "t1"],
      ["g-t1-3", "restricted", "t1"],
      ["g-t1-5", "capacity", "t1"],
      ["g-t1-7", "rule", "t1"],
    ]
  );
  assert.equal(result.changed, true);
  assert.deepEqual(log[2].params, [
    ["s-t1-2", "s-t1-3", "s-t1-5", "s-t1-6", "s-t1-7"],
    [true, true, true, false, true],
  ]);
});

// ---- 2. Local database: old vs new on random weddings ---------------------------------------------

// The re-check as it was before TS-259 (seat-checks.ts at a2f0d42), kept here only to compare against.
async function legacyCheckGuestHardRuleViolation(
  q: Queryable,
  weddingId: string,
  planVersionId: string,
  guestId: string,
  tableId: string,
  requiresAccessibleTable: boolean
): Promise<boolean> {
  const { rows: tableRows } = await q.query(`SELECT "isAccessible", "isRestricted" FROM "seating_tables" WHERE id = $1`, [tableId]);
  const table = tableRows[0] as { isAccessible: boolean; isRestricted: boolean } | undefined;
  if (!table) return false;
  if (requiresAccessibleTable && !table.isAccessible) return true;
  if (table.isRestricted) {
    const { rows: reqRows } = await q.query(`SELECT 1 FROM "restricted_table_guests" WHERE "tableId" = $1 AND "guestId" = $2`, [tableId, guestId]);
    if (reqRows.length === 0) return true;
  }
  const { rows: requiredElsewhere } = await q.query(
    `SELECT 1 FROM "restricted_table_guests" rtg JOIN "seating_tables" t ON t.id = rtg."tableId"
     WHERE rtg."guestId" = $1 AND rtg."tableId" <> $2 AND t."isRestricted" LIMIT 1`,
    [guestId, tableId]
  );
  if (requiredElsewhere.length > 0) return true;
  const { rows: conflictRows } = await q.query(
    `SELECT 1
     FROM "guest_relationships" gr
     JOIN "seat_assignments" sa2
       ON sa2."planVersionId" = $1 AND sa2."guestId" <> $3
       AND ((gr."guestAId" = $3 AND gr."guestBId" = sa2."guestId")
         OR (gr."guestBId" = $3 AND gr."guestAId" = sa2."guestId"))
     WHERE gr."weddingId" = $4
       AND ((gr.type = 'MUST_NOT_SIT_TOGETHER' AND sa2."seatingTableId" = $2)
         OR (gr.type = 'MUST_SIT_TOGETHER' AND sa2."seatingTableId" <> $2))
     LIMIT 1`,
    [planVersionId, tableId, guestId, weddingId]
  );
  return conflictRows.length > 0;
}

async function legacyResyncSeatsAtTable(client: Queryable, weddingId: string, planVersionId: string, tableId: string): Promise<Result> {
  const { rows: tableRows } = await client.query(
    `SELECT capacity, "isRestricted", "isAccessible" FROM "seating_tables" WHERE id = $1 AND "weddingId" = $2 FOR NO KEY UPDATE`,
    [tableId, weddingId]
  );
  const table = tableRows[0] as { capacity: number; isRestricted: boolean; isAccessible: boolean } | undefined;
  if (!table) return { newlyFlagged: [], changed: false };
  const { rows: requiredRows } = await client.query(`SELECT "guestId" FROM "restricted_table_guests" WHERE "tableId" = $1`, [tableId]);
  const required = new Set(requiredRows.map((r) => r.guestId as string));
  const { rows } = await client.query(
    `SELECT sa.id, sa."guestId", (g."firstName" || ' ' || g."lastName") AS name, g.headcount,
            g."requiresAccessibleTable", sa."needsReassignment"
     FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId"
     WHERE sa."planVersionId" = $1 AND sa."seatingTableId" = $2
     ORDER BY ${SEAT_ORDER}
     FOR NO KEY UPDATE OF sa`,
    [planVersionId, tableId]
  );
  const seated = rows as { id: string; guestId: string; name: string; headcount: number; requiresAccessibleTable: boolean; needsReassignment: boolean }[];
  const newlyFlagged: Result["newlyFlagged"] = [];
  let changed = false;
  let seatsUsed = 0;
  for (const a of seated) {
    const ruleBroken = await legacyCheckGuestHardRuleViolation(client, weddingId, planVersionId, a.guestId, tableId, a.requiresAccessibleTable);
    const fits = ruleBroken ? true : seatsUsed + a.headcount <= table.capacity;
    if (!ruleBroken && fits) seatsUsed += a.headcount;
    const flag = ruleBroken || !fits;
    if (flag !== a.needsReassignment) {
      changed = true;
      await client.query(`UPDATE "seat_assignments" SET "needsReassignment" = $1, "updatedAt" = now() WHERE id = $2`, [flag, a.id]);
      if (flag) {
        const reason = !fits
          ? "capacity"
          : a.requiresAccessibleTable && !table.isAccessible
            ? "accessible"
            : table.isRestricted && !required.has(a.guestId)
              ? "restricted"
              : "rule";
        newlyFlagged.push({ guestId: a.guestId, name: a.name, reason, tableId });
      }
    }
  }
  return { newlyFlagged, changed };
}

async function legacyResyncTables(client: Queryable, weddingId: string, planVersionId: string, tableIds: Iterable<string>): Promise<Result> {
  const newlyFlagged: Result["newlyFlagged"] = [];
  let changed = false;
  for (const tableId of [...new Set(tableIds)].sort()) {
    const result = await legacyResyncSeatsAtTable(client, weddingId, planVersionId, tableId);
    newlyFlagged.push(...result.newlyFlagged);
    changed ||= result.changed;
  }
  return { newlyFlagged, changed };
}

// Only ever a database on this machine (the same hosts the packages/db scripts accept).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function localDatabaseUrl(): string | null {
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      const env = readFileSync(path.join(import.meta.dirname, "../../../../packages/db/.env"), "utf8");
      url = /^DATABASE_URL="?([^"\n]+)"?/m.exec(env)?.[1];
    } catch {
      return null;
    }
  }
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
    parsed.searchParams.delete("schema");
    return parsed.toString();
  } catch {
    return null;
  }
}

type PgClient = Queryable & { connect: () => Promise<void>; end: () => Promise<void> };
const pg = createRequire(import.meta.url)("pg") as { Client: new (o: { connectionString: string; connectionTimeoutMillis: number }) => PgClient };

async function connectLocal(): Promise<PgClient | string> {
  const url = localDatabaseUrl();
  if (!url) return "no local database configured (DATABASE_URL must point at localhost)";
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query(`SELECT 1 FROM "seat_assignments" LIMIT 0`);
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    return `local database not reachable (${(err as Error & { code?: string }).code ?? (err as Error).message})`;
  }
}

const local = await connectLocal();
const skip = typeof local === "string" ? local : false;

/** A small deterministic random-number generator, so a failing case can be run again. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Values for a multi-row INSERT: ($1, $2, ...), ($n+1, ...). */
async function insertRows(q: Queryable, table: string, columns: string[], rows: unknown[][]) {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples = rows.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(", ")})`);
  await q.query(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${tuples.join(", ")}`, params);
}

interface Built {
  weddingId: string;
  planVersionId: string;
  tableIds: string[];
}

/** Builds one random small wedding (owner, tables, guests, lists, rules, two plan versions). */
async function buildWedding(q: Queryable, rand: () => number, size: { tables: number; guests: number }): Promise<Built> {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const userId = randomUUID();
  const weddingId = randomUUID();
  await q.query(`INSERT INTO "users" (id, email, "passwordHash", name, "updatedAt") VALUES ($1, $2, 'x', 'TS-259 test', now())`, [
    userId,
    `ts259-${userId}@example.test`,
  ]);
  await q.query(`INSERT INTO "weddings" (id, "ownerId", name, "updatedAt") VALUES ($1, $2, 'TS-259 test wedding', now())`, [weddingId, userId]);

  const tables = Array.from({ length: size.tables }, (_, i) => ({
    id: randomUUID(),
    capacity: 2 + Math.floor(rand() * 7),
    isRestricted: rand() < 0.3,
    isAccessible: rand() < 0.5,
    label: `T${i + 1}`,
  }));
  await insertRows(q, "seating_tables", ["id", "weddingId", "label", "capacity", "isRestricted", "isAccessible", "updatedAt"],
    tables.map((t) => [t.id, weddingId, t.label, t.capacity, t.isRestricted, t.isAccessible, new Date()]));

  const guests = Array.from({ length: size.guests }, (_, i) => ({
    id: randomUUID(),
    headcount: 1 + Math.floor(rand() * 3),
    requiresAccessibleTable: rand() < 0.2,
    isLocked: rand() < 0.2,
    firstName: pick(["Ann", "Bo", "Cy", "Di"]),
    lastName: `Guest${i}`,
  }));
  await insertRows(q, "guests", ["id", "weddingId", "firstName", "lastName", "headcount", "requiresAccessibleTable", "isLocked", "updatedAt"],
    guests.map((g) => [g.id, weddingId, g.firstName, g.lastName, g.headcount, g.requiresAccessibleTable, g.isLocked, new Date()]));

  // Required-guest lists: mostly on Restricted tables, sometimes left on one that isn't (any more).
  const listed = new Set<string>();
  const rtg: unknown[][] = [];
  for (const t of tables) {
    if (!t.isRestricted && rand() < 0.8) continue;
    for (const g of guests) {
      if (rand() < 0.12 && !listed.has(g.id)) {
        listed.add(g.id); // a guest is on at most one list (unique "guestId")
        rtg.push([randomUUID(), t.id, g.id]);
      }
    }
  }
  await insertRows(q, "restricted_table_guests", ["id", "tableId", "guestId"], rtg);

  // Seating rules between random pairs.
  const rels: unknown[][] = [];
  const pairs = new Set<string>();
  for (let i = 0; i < Math.ceil(size.guests / 3); i++) {
    const a = pick(guests);
    const b = pick(guests);
    if (a.id === b.id || pairs.has([a.id, b.id].sort().join())) continue;
    pairs.add([a.id, b.id].sort().join());
    rels.push([randomUUID(), weddingId, a.id, b.id, rand() < 0.5 ? "MUST_SIT_TOGETHER" : "MUST_NOT_SIT_TOGETHER"]);
  }
  if (rels.length > 0) {
    const params: unknown[] = [];
    const tuples = rels.map((r) => `(${r.map((v, j) => (params.push(v), `$${params.length}${j === 4 ? `::"RelationshipType"` : ""}`)).join(", ")})`);
    await q.query(`INSERT INTO "guest_relationships" (id, "weddingId", "guestAId", "guestBId", type) VALUES ${tuples.join(", ")}`, params);
  }

  // Two plan versions: the one re-checked, and another whose seats must be ignored.
  const planVersionId = randomUUID();
  const otherPlanId = randomUUID();
  await insertRows(q, "plan_versions", ["id", "weddingId", "versionNumber"], [
    [planVersionId, weddingId, 1],
    [otherPlanId, weddingId, 2],
  ]);
  // Seats: most guests, at random tables (so some tables are over capacity), seated at a few
  // shared moments (ties broken by guest id), some already flagged.
  const moments = [new Date("2026-10-01T12:00:00Z"), new Date("2026-10-01T12:00:01Z"), new Date("2026-10-02T09:30:00Z")];
  const seats: unknown[][] = [];
  for (const plan of [planVersionId, otherPlanId]) {
    for (const g of guests) {
      if (rand() < 0.15) continue;
      seats.push([randomUUID(), plan, g.id, pick(tables).id, rand() < 0.3, pick(moments), new Date()]);
    }
  }
  await insertRows(q, "seat_assignments", ["id", "planVersionId", "guestId", "seatingTableId", "needsReassignment", "createdAt", "updatedAt"], seats);
  return { weddingId, planVersionId, tableIds: tables.map((t) => t.id) };
}

function counting(q: Queryable) {
  const counter: { n: number; client: Queryable } = {
    n: 0,
    client: {
      query: (text, params) => {
        counter.n++;
        return q.query(text, params);
      },
    },
  };
  return counter;
}

async function flagsOf(q: Queryable, planVersionId: string): Promise<Record<string, boolean>> {
  const { rows } = await q.query(`SELECT id, "needsReassignment" FROM "seat_assignments" WHERE "planVersionId" = $1 ORDER BY id`, [planVersionId]);
  return Object.fromEntries(rows.map((r) => [r.id as string, r.needsReassignment as boolean]));
}

test("TS-259: on random weddings in the local database, the new re-check flags exactly what the old one did", { skip }, async () => {
  const q = local as PgClient;
  await q.query("BEGIN");
  try {
    const reasons = new Map<string, number>();
    let cases = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rand = mulberry32(seed);
      const built = await buildWedding(q, rand, { tables: 2 + Math.floor(rand() * 5), guests: 4 + Math.floor(rand() * 26) });
      // All the tables, a random few, and one id that isn't the wedding's.
      const subsets = [built.tableIds, built.tableIds.filter(() => rand() < 0.5), [built.tableIds[0], randomUUID()]];
      for (const ids of subsets) {
        await q.query("SAVEPOINT ts259");
        const before = await flagsOf(q, built.planVersionId);
        const old = await legacyResyncTables(q, built.weddingId, built.planVersionId, ids);
        const oldFlags = await flagsOf(q, built.planVersionId);
        await q.query("ROLLBACK TO SAVEPOINT ts259");
        assert.deepEqual(await flagsOf(q, built.planVersionId), before);
        const counter = counting(q);
        const now = await resyncTables(counter.client as never, built.weddingId, built.planVersionId, ids);
        const newFlags = await flagsOf(q, built.planVersionId);
        await q.query("RELEASE SAVEPOINT ts259");
        const where = `seed ${seed}, ${ids.length} table(s)`;
        assert.deepEqual(now, old, `newlyFlagged/changed differ (${where})`);
        assert.deepEqual(newFlags, oldFlags, `flags differ (${where})`);
        assert.ok(counter.n <= 3, `${counter.n} queries (${where})`);
        // Run again: nothing left to change, and only the two reads.
        const again = counting(q);
        assert.deepEqual(await resyncTables(again.client as never, built.weddingId, built.planVersionId, ids), { newlyFlagged: [], changed: false });
        assert.ok(again.n <= 2);
        for (const f of now.newlyFlagged) reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + 1);
        cases++;
      }
    }
    // The random weddings must actually have exercised every kind of flag.
    for (const reason of ["capacity", "accessible", "restricted", "rule"]) {
      assert.ok((reasons.get(reason) ?? 0) > 0, `no "${reason}" flag in ${cases} cases: ${JSON.stringify([...reasons])}`);
    }
  } finally {
    await q.query("ROLLBACK");
  }
});

test("TS-259: hand-built cases in the local database match the old re-check", { skip }, async () => {
  const q = local as PgClient;
  await q.query("BEGIN");
  try {
    const built = await buildWedding(q, mulberry32(999), { tables: 4, guests: 0 });
    const [t1, t2, t3, t4] = built.tableIds;
    const w = built.weddingId;
    const p = built.planVersionId;
    // t1: 3 seats, accessible, not restricted. t2: restricted, accessible. t3: not accessible. t4: 2 seats.
    await q.query(`UPDATE "seating_tables" SET capacity = 3, "isAccessible" = true, "isRestricted" = false WHERE id = $1`, [t1]);
    await q.query(`UPDATE "seating_tables" SET capacity = 8, "isAccessible" = true, "isRestricted" = true WHERE id = $1`, [t2]);
    await q.query(`UPDATE "seating_tables" SET capacity = 8, "isAccessible" = false, "isRestricted" = false WHERE id = $1`, [t3]);
    await q.query(`UPDATE "seating_tables" SET capacity = 2, "isAccessible" = true, "isRestricted" = false WHERE id = $1`, [t4]);
    const g = (n: number, headcount = 1, extra: { locked?: boolean; accessible?: boolean } = {}) => ({ id: `ts259-${w}-${n}`, n, headcount, ...extra });
    const guests = [
      g(1, 2), g(2, 1, { locked: true }), g(3, 1), // t1: locked g2 first, then g1 (2) = 3, g3 overflows
      g(4), g(5), // t2: g4 listed, g5 isn't -> restricted
      g(6, 1, { accessible: true }), // t3: needs accessible -> accessible
      g(7), // t4: on t2's list, seated at t4 -> rule (required elsewhere)
      g(8), g(9), // t4 (with g7): must-not-sit-together -> both rule (each sees the other)
      g(10), g(11), // must-sit-together, g10 at t3 and g11 at t1? (t1 is full) -> g10 at t3, g11 unseated -> no conflict
      g(12), g(13), // must-sit-together split t3 / t2 (g13 also unlisted at t2) -> g12 rule, g13 restricted
    ];
    await insertRows(q, "guests", ["id", "weddingId", "firstName", "lastName", "headcount", "requiresAccessibleTable", "isLocked", "updatedAt"],
      guests.map((x) => [x.id, w, "Case", `G${x.n}`, x.headcount, x.accessible ?? false, x.locked ?? false, new Date()]));
    const id = (n: number) => `ts259-${w}-${n}`;
    await insertRows(q, "restricted_table_guests", ["id", "tableId", "guestId"], [[randomUUID(), t2, id(4)], [randomUUID(), t2, id(7)]]);
    const params = [w, id(8), id(9), id(10), id(11), id(12), id(13)];
    await q.query(
      `INSERT INTO "guest_relationships" (id, "weddingId", "guestAId", "guestBId", type) VALUES
       (gen_random_uuid()::text, $1, $2, $3, 'MUST_NOT_SIT_TOGETHER'),
       (gen_random_uuid()::text, $1, $4, $5, 'MUST_SIT_TOGETHER'),
       (gen_random_uuid()::text, $1, $7, $6, 'MUST_SIT_TOGETHER')`,
      params
    );
    const at = new Date("2026-10-01T12:00:00Z");
    const seatAt: [number, string][] = [[1, t1], [2, t1], [3, t1], [4, t2], [5, t2], [6, t3], [7, t4], [8, t4], [9, t4], [10, t3], [12, t3], [13, t2]];
    await insertRows(q, "seat_assignments", ["id", "planVersionId", "guestId", "seatingTableId", "needsReassignment", "createdAt", "updatedAt"],
      seatAt.map(([n, t]) => [`seat-${w}-${n}`, p, id(n), t, false, at, new Date()]));

    await q.query("SAVEPOINT ts259");
    const old = await legacyResyncTables(q, w, p, built.tableIds);
    const oldFlags = await flagsOf(q, p);
    await q.query("ROLLBACK TO SAVEPOINT ts259");
    const now = await resyncTables(q as never, w, p, built.tableIds);
    assert.deepEqual(now, old);
    assert.deepEqual(await flagsOf(q, p), oldFlags);
    const byGuest = Object.fromEntries(now.newlyFlagged.map((f) => [f.guestId.split("-").at(-1), f.reason]));
    assert.deepEqual(byGuest, {
      "3": "capacity",
      "5": "restricted",
      "6": "accessible",
      "7": "rule",
      "8": "rule",
      "9": "rule",
      "12": "rule",
      "13": "restricted",
    });
  } finally {
    await q.query("ROLLBACK");
  }
});

test("TS-259: in the local database the re-check's query count stays the same as the wedding grows", { skip }, async () => {
  const q = local as PgClient;
  await q.query("BEGIN");
  try {
    const counts: { guests: number; legacy: number; now: number }[] = [];
    for (const [tables, guests] of [
      [3, 10],
      [30, 200],
    ]) {
      const built = await buildWedding(q, mulberry32(tables), { tables, guests });
      await q.query("SAVEPOINT ts259");
      const legacy = counting(q);
      await legacyResyncTables(legacy.client, built.weddingId, built.planVersionId, built.tableIds);
      await q.query("ROLLBACK TO SAVEPOINT ts259");
      const now = counting(q);
      await resyncTables(now.client as never, built.weddingId, built.planVersionId, built.tableIds);
      counts.push({ guests, legacy: legacy.n, now: now.n });
    }
    assert.ok(counts.every((c) => c.now <= 3), JSON.stringify(counts));
    assert.ok(counts[1].legacy > counts[0].legacy * 5, `the old one grew with the guests: ${JSON.stringify(counts)}`);
  } finally {
    await q.query("ROLLBACK");
  }
});

test("TS-259: close the local database connection", { skip }, async () => {
  await (local as PgClient).end();
});
