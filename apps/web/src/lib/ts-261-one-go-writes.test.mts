// TS-261: unit tests for writes that used to go one row at a time and now go in one statement --
// "Reset all guest and vendor links", copying a room layout (save as template, apply a template,
// duplicate a wedding, create a wedding from a template), quick-create, and wedding notifications.
//   1. Scripted stand-in database (always runs): the number of statements is the same for 2 rows as
//      for 2,000, the locks are taken in the same order as before, and the values written (labels,
//      positions, sort order, tokens, recipients) are the ones the old row-by-row code wrote.
//   2. Local database (runs only when the database in packages/db/.env, or DATABASE_URL, is on this
//      machine and reachable -- skipped otherwise, e.g. in CI's unit job, which has no Postgres):
//      the real functions run inside one outer transaction that is always rolled back (their own
//      BEGIN/COMMIT become savepoints), at the caps: 2,000 guests + 200 vendors, 300 tables,
//      100 quick-created tables, 20 members. Never connects anywhere but localhost.
// Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { hashLinkToken, readStoredLinkToken } from "../../../../packages/db/src/link-tokens";

const db = await import("@seatwise/db");
const { pool } = db;

type Rows = Record<string, unknown>[];
type Responder = (sql: string, params: unknown[]) => Rows | undefined;
type Statement = { sql: string; params: unknown[] };

const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);
afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
});

// ---- 1. Scripted stand-in --------------------------------------------------------------------------

/** Replaces the pool with a stand-in that answers with `respond` and records every statement. */
function standIn(respond: Responder): Statement[] {
  const log: Statement[] = [];
  const run = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    log.push({ sql: text, params });
    const rows = respond(text, params) ?? [];
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
  return log;
}

const at = (log: Statement[], re: RegExp) => log.findIndex((s) => re.test(s.sql));
const count = (log: Statement[], re: RegExp) => log.filter((s) => re.test(s.sql)).length;
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);

// --- Link reset

function linkReset(guests: number, vendors: number) {
  return standIn((sql) => {
    if (/FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return [{ ownerId: "owner" }];
    if (/^SELECT id FROM "guests"/.test(sql)) return ids("g", guests).map((id) => ({ id }));
    if (/^SELECT id FROM "vendors"/.test(sql)) return ids("v", vendors).map((id) => ({ id }));
    return undefined;
  });
}

test("TS-261: resetting links is the same number of statements for 3 links as for 2,200", async () => {
  const small = linkReset(2, 1);
  assert.deepEqual(await db.resetWeddingLinkTokens("w1", "owner"), { guestLinks: 2, vendorLinks: 1 });
  const big = linkReset(2000, 200);
  assert.deepEqual(await db.resetWeddingLinkTokens("w1", "owner"), { guestLinks: 2000, vendorLinks: 200 });
  assert.equal(big.length, small.length, big.map((s) => s.sql.slice(0, 50)).join(" | "));
  assert.equal(big.length, 7, "BEGIN, wedding lock, guests lock, guests update, vendors lock, vendors update, COMMIT");
});

test("TS-261: links are locked as before (wedding, then guests by id, then vendors by id) and each gets its own new token", async () => {
  const log = linkReset(500, 50);
  await db.resetWeddingLinkTokens("w1", "owner");
  const wedding = at(log, /FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/);
  const guestLock = at(log, /^SELECT id FROM "guests" .* ORDER BY id FOR UPDATE$/);
  const guestUpdate = at(log, /^UPDATE "guests" AS t SET "rsvpToken" = v\.encrypted, "rsvpTokenHash" = v\.hash FROM unnest\(/);
  const vendorLock = at(log, /^SELECT id FROM "vendors" .* ORDER BY id FOR UPDATE$/);
  const vendorUpdate = at(log, /^UPDATE "vendors" AS t SET "shareToken" = v\.encrypted, "shareTokenHash" = v\.hash FROM unnest\(/);
  assert.ok(log[0].sql.startsWith("BEGIN"));
  assert.ok(wedding < guestLock && guestLock < guestUpdate && guestUpdate < vendorLock && vendorLock < vendorUpdate, log.map((s) => s.sql.slice(0, 40)).join(" | "));
  assert.equal(log.at(-1)!.sql, "COMMIT");

  for (const [index, expected] of [[guestUpdate, ids("g", 500)], [vendorUpdate, ids("v", 50)]] as const) {
    const [rowIds, encrypted, hashes] = log[index].params as string[][];
    assert.deepEqual(rowIds, expected, "every locked row, once");
    assert.equal(new Set(hashes).size, hashes.length, "every token is different");
    encrypted.forEach((e, i) => {
      assert.ok(e.startsWith("enc:v1:"), "the stored copy is encrypted");
      assert.equal(hashLinkToken(readStoredLinkToken(e)!), hashes[i], "the hash is the stored token's");
    });
  }
});

test("TS-261: a wedding with no links sends no UPDATE; someone not the owner changes nothing", async () => {
  const none = linkReset(0, 0);
  assert.deepEqual(await db.resetWeddingLinkTokens("w1", "owner"), { guestLinks: 0, vendorLinks: 0 });
  assert.equal(count(none, /^UPDATE/), 0);
  const refused = linkReset(10, 10);
  await assert.rejects(db.resetWeddingLinkTokens("w1", "someone-else"), db.LinkResetNotOwnerError);
  assert.equal(count(refused, /^UPDATE/), 0);
  assert.equal(refused.at(-1)!.sql, "ROLLBACK");
});

// --- Table copies

interface Layout {
  label: string;
  capacity: number;
  isRestricted: boolean;
  isAccessible: boolean;
  isLocked: boolean;
  purpose: string | null;
  purposeCriterionType: string | null;
  purposeCriterionValue: string | null;
  singleSideOnly: boolean;
  shape: string;
  positionX: number | null;
  positionY: number | null;
}

function layout(n: number): Layout[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `Table ${i + 1}`,
    capacity: 4 + (i % 7),
    isRestricted: i % 5 === 0,
    isAccessible: i % 3 === 0,
    isLocked: i % 4 === 0,
    purpose: i % 6 === 0 ? `Purpose ${i}` : null,
    purposeCriterionType: i % 6 === 0 ? "TIER" : null,
    purposeCriterionValue: i % 6 === 0 ? "FAMILY" : null,
    singleSideOnly: i % 2 === 0,
    shape: ["ROUND", "RECTANGULAR", "SQUARE"][i % 3],
    positionX: i % 9 === 0 ? null : i * 10.5,
    positionY: i % 9 === 0 ? null : i * 3,
  }));
}

/** The rows a copy wrote: the unnest arrays ($1 ids, $3..$14 columns) zipped back into tables. */
function copiedRows(statement: Statement): (Layout & { id: string })[] {
  const p = statement.params as unknown[][];
  return (p[0] as string[]).map((id, i) => ({
    id,
    label: p[2][i] as string,
    capacity: p[3][i] as number,
    isRestricted: p[4][i] as boolean,
    isAccessible: p[5][i] as boolean,
    isLocked: p[6][i] as boolean,
    purpose: p[7][i] as string | null,
    purposeCriterionType: p[8][i] as string | null,
    purposeCriterionValue: p[9][i] as string | null,
    singleSideOnly: p[10][i] as boolean,
    shape: p[11][i] as string,
    positionX: p[12][i] as number | null,
    positionY: p[13][i] as number | null,
  }));
}
/** The rows with the named columns left out (new ids and the like, which differ every time). */
function without<T extends object>(rows: T[], ...keys: string[]): Omit<T, "id">[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))) as Omit<T, "id">);
}
const withoutId = <T extends { id: string }>(rows: T[]) => without(rows, "id");

/** A wedding that already has `existing` labels and can open a template holding `template`. */
function copying(template: Layout[], existing: string[]) {
  return standIn((sql) => {
    if (/^SELECT 1 FROM "seating_templates"/.test(sql)) return [{}];
    if (/FROM "seating_template_tables" WHERE "templateId" = \$1 ORDER BY "sortOrder"/.test(sql)) return template as unknown as Rows;
    if (/^SELECT "sideMixing" FROM "seating_templates"/.test(sql)) return [{ sideMixing: "BALANCED_MIX" }];
    if (/FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return [{ ownerId: "owner" }];
    if (/^SELECT "venueName", "sideMixing"/.test(sql)) return [{ venueName: null, sideMixing: "BALANCED_MIX", sideLabel1: "Bride", sideLabel2: "Groom" }];
    if (/^SELECT "sideMixing" FROM "weddings"/.test(sql)) return [{ sideMixing: "BALANCED_MIX" }];
    if (/FROM "seating_tables" WHERE "weddingId" = \$1( ORDER BY "createdAt")?$/.test(sql) && /positionX/.test(sql)) {
      return [...template].reverse() as unknown as Rows; // the source wedding's tables, out of order
    }
    if (/^SELECT count\(\*\)::int AS n FROM "seating_tables"/.test(sql)) return [{ n: existing.length }];
    if (/^SELECT label FROM "seating_tables"/.test(sql)) return existing.map((label) => ({ label }));
    if (/^INSERT INTO "weddings"/.test(sql)) return [{ id: "new-wedding" }];
    return undefined;
  });
}

const COPY_INSERT = /^INSERT INTO "seating_tables" .* FROM unnest\(\$1::text\[\], \$3::text\[\]/;
const TEMPLATE_COPY_INSERT = /^INSERT INTO "seating_template_tables" .* FROM unnest\(\$1::text\[\], \$3::text\[\]/;

test("TS-261: applying a template is one INSERT whether it has 2 tables or 300, with the same names as before", async () => {
  const small = copying(layout(2), ["Table 1"]);
  assert.equal(await db.addTemplateTablesToWedding("w1", "tpl", "owner"), 2);
  const big = copying(layout(300), []);
  assert.equal(await db.addTemplateTablesToWedding("w1", "tpl", "owner"), 300);
  assert.equal(big.length, small.length);
  assert.equal(count(big, /^INSERT/), 1);
  assert.deepEqual(withoutId(copiedRows(big[at(big, COPY_INSERT)])), layout(300), "every field, in the template's order");

  // A name already used gets " (2)" -- and a name made that way is taken for the rest, as before.
  const clash = copying([{ ...layout(1)[0], label: "Head" }, { ...layout(1)[0], label: "Head" }, layout(1)[0]], ["Head", "Table 1"]);
  await db.addTemplateTablesToWedding("w1", "tpl", "owner");
  assert.deepEqual(copiedRows(clash[at(clash, COPY_INSERT)]).map((r) => r.label), ["Head (2)", "Head (3)", "Table 1 (2)"]);
  // The wedding's lock and the cap still come before anything is written.
  assert.ok(at(clash, /FOR NO KEY UPDATE/) < at(clash, /count\(\*\)/) && at(clash, /count\(\*\)/) < at(clash, COPY_INSERT));
});

test("TS-261: applying a template past the 300-table cap still writes nothing", async () => {
  const log = copying(layout(5), ids("T", 299));
  await assert.rejects(db.addTemplateTablesToWedding("w1", "tpl", "owner"), db.WeddingCapError);
  assert.equal(count(log, /^INSERT/), 0);
});

test("TS-261: duplicating a wedding copies its tables in one INSERT, in label order", async () => {
  const small = copying(layout(2), []);
  await db.duplicateWeddingLayout("src", "owner", "Copy");
  const big = copying(layout(300), []);
  await db.duplicateWeddingLayout("src", "owner", "Copy");
  assert.equal(big.length, small.length);
  assert.equal(count(big, /^INSERT INTO "seating_tables"/), 1);
  assert.deepEqual(withoutId(copiedRows(big[at(big, COPY_INSERT)])), layout(300), "Table 1, Table 2 ... Table 300 (numbers in order)");
});

test("TS-261: creating a wedding from a template copies its tables in one INSERT", async () => {
  const run = async (n: number) => {
    const log = copying(layout(n), []);
    await db.createWedding("owner", { name: "New", templateId: "tpl", applyTemplateTables: true });
    return log;
  };
  const small = await run(2);
  const big = await run(300);
  assert.equal(big.length, small.length);
  assert.equal(count(big, /^INSERT INTO "seating_tables"/), 1);
  assert.equal(big[at(big, COPY_INSERT)].params[1], big[at(big, /^INSERT INTO "weddings"/)].params[0], "into the new wedding");
  assert.deepEqual(withoutId(copiedRows(big[at(big, COPY_INSERT)])), layout(300));
  // Without the template's tables, no table INSERT at all.
  const none = copying(layout(3), []);
  await db.createWedding("owner", { name: "New", templateId: "tpl", applyTemplateTables: false });
  assert.equal(count(none, /^INSERT INTO "seating_tables"/), 0);
});

test("TS-261: saving a wedding as a template is one INSERT, sortOrder following the numbers in the labels", async () => {
  const run = async (n: number) => {
    const log = copying(layout(n), []);
    await db.createTemplateFromWedding("owner", "w1", "My layout");
    return log;
  };
  const small = await run(2);
  const big = await run(300);
  assert.equal(big.length, small.length);
  const insert = big[at(big, TEMPLATE_COPY_INSERT)];
  assert.match(insert.sql, /\(v\.n - 1\)::int FROM unnest\(.*\) WITH ORDINALITY/, "sortOrder is 0, 1, 2... in the order given");
  assert.deepEqual(withoutId(copiedRows(insert)), layout(300), "label order: Table 2 before Table 10");
});

test("TS-261: quick-create is one INSERT for 2 tables or 100, with the same names, grid places and returned order", async () => {
  const run = (n: number, existing: string[]) => {
    const log = standIn((sql, params) => {
      if (/FOR NO KEY UPDATE/.test(sql)) return [{ ownerId: "owner" }];
      if (/^SELECT count\(\*\)::int AS n/.test(sql)) return [{ n: existing.length }];
      if (/^SELECT label FROM "seating_tables"/.test(sql)) return existing.map((label) => ({ label }));
      if (/^INSERT INTO "seating_tables"/.test(sql)) {
        const [rowIds, , labels, , , xs, ys] = params as [string[], string, string[], number, string, number[], number[]];
        // Handed back out of order: the function puts them back in the order it made them.
        return rowIds.map((id, i) => ({ id, label: labels[i], positionX: xs[i], positionY: ys[i] })).reverse();
      }
      return undefined;
    });
    return { log, created: db.quickCreateSeatingTables("w1", { count: n, capacity: 8, shape: "ROUND", labelPrefix: "Table" }) };
  };
  const small = run(2, ["Table 1"]);
  await small.created;
  const big = run(100, ["Table 1", "Table 3", "Head"]);
  const created = await big.created;
  assert.equal(big.log.length, small.log.length);
  assert.equal(count(big.log, /^INSERT/), 1);
  // Numbering continues after the highest number used (TS-153): Table 4 ... Table 103.
  assert.deepEqual(created.map((t) => t.label), Array.from({ length: 100 }, (_, i) => `Table ${i + 4}`));
  // Grid places continue after the 3 tables already there: 4 across, 264 by 240 apart.
  created.forEach((t, i) => {
    const index = 3 + i;
    assert.deepEqual([t.positionX, t.positionY], [40 + (index % 4) * 264, 40 + Math.floor(index / 4) * 240]);
    assert.deepEqual(t.requiredGuestIds, []);
  });
});

// --- Notifications

const MEMBERS_READ = /UNION/;
function members(n: number, opts: { removed?: string[]; failBatch?: boolean; failCommit?: boolean } = {}) {
  const everyone = ["owner", ...ids("c", n)].map((id) => ({ id, email: `${id}@example.invalid`, emailVerifiedAt: null, wantsEmail: false }));
  return standIn((sql, params) => {
    if (/^SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings"/.test(sql)) return [{ ownerId: "owner", name: "W", emailNotificationsEnabled: false }];
    if (MEMBERS_READ.test(sql)) return everyone;
    if (/^SELECT "ownerId" FROM "weddings" WHERE id = \$1 FOR KEY SHARE$/.test(sql)) return [{ ownerId: "owner" }];
    if (/^SELECT id FROM "users" WHERE id = ANY/.test(sql)) return (params[0] as string[]).map((id) => ({ id }));
    if (/^SELECT 1 FROM "users" WHERE id = \$1 FOR KEY SHARE$/.test(sql)) return [{}];
    if (/^SELECT "userId" FROM "wedding_collaborators" .* = ANY/.test(sql)) {
      return (params[1] as string[]).filter((id) => !opts.removed?.includes(id)).map((userId) => ({ userId }));
    }
    if (/^SELECT 1 FROM "wedding_collaborators" .* FOR KEY SHARE$/.test(sql)) return opts.removed?.includes(params[1] as string) ? [] : [{}];
    if (/^INSERT INTO "notifications" .* unnest/.test(sql) && opts.failBatch) throw Object.assign(new Error("busy"), { code: "40P01" });
    if (sql === "COMMIT" && opts.failCommit) throw new Error("Connection terminated unexpectedly");
    return undefined;
  });
}

test("TS-261: notifying 20 members is the same number of statements as notifying 3", async () => {
  const small = members(3);
  await db.notifyWeddingCollaborators("w1", "c00000", "GUEST_ADDED", "Ann Lee was added.");
  const big = members(20);
  await db.notifyWeddingCollaborators("w1", "c00000", "GUEST_ADDED", "Ann Lee was added.");
  assert.equal(big.length, small.length, big.map((s) => s.sql.slice(0, 50)).join(" | "));
  assert.equal(big.length, 8, "2 reads, then BEGIN, wedding, accounts, access rows, INSERT, COMMIT");
  const insert = big[at(big, /^INSERT INTO "notifications"/)];
  const [newIds, weddingId, type, message, recipients] = insert.params as [string[], string, string, string, string[]];
  assert.deepEqual([weddingId, type, message], ["w1", "GUEST_ADDED", "Ann Lee was added."]);
  assert.deepEqual(recipients, ["c00001", "c00002", "c00003", "c00004", "c00005", "c00006", "c00007", "c00008", "c00009", "c00010", "c00011", "c00012", "c00013", "c00014", "c00015", "c00016", "c00017", "c00018", "c00019", "owner"], "everyone but whoever caused it, owner included");
  assert.equal(new Set(newIds).size, recipients.length);
});

test("TS-261: the locks are the same as one at a time -- wedding, then accounts, then access rows, then the INSERT", async () => {
  const log = members(5);
  await db.notifyWeddingCollaborators("w1", null, "RSVP_RECEIVED", "Ann Lee answered.");
  const begin = at(log, /^BEGIN/);
  const wedding = at(log, /^SELECT "ownerId" FROM "weddings" WHERE id = \$1 FOR KEY SHARE$/);
  const accounts = at(log, /^SELECT id FROM "users" WHERE id = ANY\(\$1::text\[\]\) ORDER BY id FOR KEY SHARE$/);
  const access = at(log, /^SELECT "userId" FROM "wedding_collaborators" WHERE "weddingId" = \$1 AND "userId" = ANY\(\$2::text\[\]\) ORDER BY "userId" FOR KEY SHARE$/);
  const insert = at(log, /^INSERT INTO "notifications"/);
  assert.ok(begin >= 0 && begin < wedding && wedding < accounts && accounts < access && access < insert && insert < at(log, /^COMMIT$/), log.map((s) => s.sql.slice(0, 40)).join(" | "));
  assert.doesNotMatch(log[insert].sql, /wedding_collaborators/, "the INSERT takes no locks of its own");
  assert.ok(!(log[access].params[1] as string[]).includes("owner"), "the owner needs no access row");
});

test("TS-261: someone removed a moment ago is skipped, the rest are notified", async () => {
  const log = members(4, { removed: ["c00002"] });
  await db.notifyWeddingCollaborators("w1", "owner", "GUEST_ADDED", "x");
  const recipients = log[at(log, /^INSERT INTO "notifications"/)].params[4] as string[];
  assert.deepEqual(recipients, ["c00000", "c00001", "c00003"]);
});

test("TS-261: if writing them together fails, each is tried on their own, as before", async () => {
  const log = members(3, { removed: ["c00001"], failBatch: true });
  await db.notifyWeddingCollaborators("w1", "owner", "GUEST_ADDED", "x");
  assert.ok(at(log, /^ROLLBACK$/) > at(log, /unnest/), "the failed batch is rolled back");
  const singles = log.filter((s) => /^INSERT INTO "notifications" .* VALUES/.test(s.sql)).map((s) => s.params[2]);
  assert.deepEqual(singles, ["c00000", "c00002"]);
});

test("TS-261: if the batch's COMMIT gets no answer, nobody is notified a second time", async () => {
  const log = members(3, { failCommit: true });
  await db.notifyWeddingCollaborators("w1", "owner", "GUEST_ADDED", "x");
  assert.equal(count(log, /unnest/), 1, "the batch was sent once");
  assert.equal(count(log, /^INSERT INTO "notifications" .* VALUES/), 0, "no one-at-a-time retries -- they may already have it");
  assert.equal(count(log, /^ROLLBACK$/), 0, "nothing to roll back once COMMIT was sent");
});

test("TS-261: one recipient still goes the one-at-a-time way (nothing changes for them)", async () => {
  const log = members(1);
  await db.notifyWeddingCollaborators("w1", "owner", "GUEST_ADDED", "x");
  assert.equal(count(log, /unnest/), 0);
  assert.equal(count(log, /^INSERT INTO "notifications" .* VALUES/), 1);
});

// ---- 2. Local database -----------------------------------------------------------------------------

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

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Rows; rowCount?: number | null }> };
type PgClient = Queryable & { connect: () => Promise<void>; end: () => Promise<void> };
const pg = createRequire(import.meta.url)("pg") as { Client: new (o: { connectionString: string; connectionTimeoutMillis: number }) => PgClient };

async function connectLocal(): Promise<PgClient | string> {
  const url = localDatabaseUrl();
  if (!url) return "no local database configured (DATABASE_URL must point at localhost)";
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query(`SELECT 1 FROM "notifications" LIMIT 0`);
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    return `local database not reachable (${(err as Error & { code?: string }).code ?? (err as Error).message})`;
  }
}

const local = await connectLocal();
const skip = typeof local === "string" ? local : false;

/**
 * Runs `fn` with the app's pool pointed at the local client, inside one transaction that is always
 * rolled back: each function's own BEGIN / COMMIT / ROLLBACK become a savepoint, so it behaves as
 * it would for real but nothing is kept. Counts the statements the app sent.
 */
async function rolledBack(fn: (q: Queryable, sent: { n: number; reset: () => void }) => Promise<void>) {
  const q = local as PgClient;
  const sent = { n: 0, reset: () => (sent.n = 0) };
  const run = async (sql: string, params?: unknown[]) => {
    sent.n++;
    const text = sql.trim();
    if (text.startsWith("BEGIN")) return q.query("SAVEPOINT app");
    if (text === "COMMIT") return q.query("RELEASE SAVEPOINT app");
    if (text === "ROLLBACK") {
      await q.query("ROLLBACK TO SAVEPOINT app");
      return q.query("RELEASE SAVEPOINT app");
    }
    return q.query(sql, params);
  };
  await q.query("BEGIN");
  try {
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
    (pool as unknown as { query: unknown }).query = run;
    await fn(q, sent);
  } finally {
    (pool as unknown as { connect: unknown }).connect = realConnect;
    (pool as unknown as { query: unknown }).query = realQuery;
    await q.query("ROLLBACK");
  }
}

async function insertRows(q: Queryable, table: string, columns: string[], rows: unknown[][]) {
  for (let start = 0; start < rows.length; start += 500) {
    const params: unknown[] = [];
    const tuples = rows.slice(start, start + 500).map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(", ")})`);
    await q.query(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${tuples.join(", ")}`, params);
  }
}

async function newUser(q: Queryable): Promise<string> {
  const id = randomUUID();
  await q.query(`INSERT INTO "users" (id, email, "passwordHash", name, "updatedAt") VALUES ($1, $2, 'x', 'TS-261 test', now())`, [id, `ts261-${id}@example.test`]);
  return id;
}
async function newWedding(q: Queryable, ownerId: string): Promise<string> {
  const id = randomUUID();
  await q.query(`INSERT INTO "weddings" (id, "ownerId", name, "emailNotificationsEnabled", "updatedAt") VALUES ($1, $2, 'TS-261 test wedding', false, now())`, [id, ownerId]);
  return id;
}

const TABLE_FIELDS = `label, capacity, "isRestricted", "isAccessible", "isLocked", purpose, "purposeCriterionType"::text AS "purposeCriterionType",
  "purposeCriterionValue", "singleSideOnly", shape::text AS shape, "positionX", "positionY"`;
async function tablesOf(q: Queryable, weddingId: string): Promise<Layout[]> {
  const { rows } = await q.query(`SELECT ${TABLE_FIELDS} FROM "seating_tables" WHERE "weddingId" = $1`, [weddingId]);
  return (rows as unknown as Layout[]).sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
}
const byLabel = (rows: Layout[]) => [...rows].sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));

const counts: Record<string, number> = {};

test("TS-261 (local database): resetting 2,000 guest and 200 vendor links -- every one new, unique and working", { skip }, async () => {
  await rolledBack(async (q, sent) => {
    const owner = await newUser(q);
    const wedding = await newWedding(q, owner);
    const oldGuest = (i: number) => (i < 1990 ? `old-guest-${wedding}-${i}` : null); // 10 guests never had a link
    await insertRows(q, "guests", ["id", "weddingId", "firstName", "lastName", "rsvpTokenHash", "updatedAt"],
      Array.from({ length: 2000 }, (_, i) => [randomUUID(), wedding, "G", `${i}`, oldGuest(i), new Date()]));
    await insertRows(q, "vendors", ["id", "weddingId", "name", "category", "shareTokenHash", "updatedAt"],
      Array.from({ length: 200 }, (_, i) => [randomUUID(), wedding, `V${i}`, "CATERING", `old-vendor-${wedding}-${i}`, new Date()]));

    sent.reset();
    assert.deepEqual(await db.resetWeddingLinkTokens(wedding, owner), { guestLinks: 1990, vendorLinks: 200 });
    counts.linkReset = sent.n;

    const { rows: guests } = await q.query(`SELECT "rsvpToken", "rsvpTokenHash" FROM "guests" WHERE "weddingId" = $1`, [wedding]);
    const withLink = guests.filter((g) => g.rsvpTokenHash !== null);
    assert.equal(withLink.length, 1990, "the 10 guests without a link still have none");
    assert.ok(guests.filter((g) => g.rsvpTokenHash === null).every((g) => g.rsvpToken === null));
    const { rows: vendors } = await q.query(`SELECT "shareToken" AS "rsvpToken", "shareTokenHash" AS "rsvpTokenHash" FROM "vendors" WHERE "weddingId" = $1`, [wedding]);
    const all = [...withLink, ...vendors];
    assert.equal(new Set(all.map((r) => r.rsvpTokenHash)).size, 2190, "every link is different");
    for (const r of all) {
      assert.ok(!String(r.rsvpTokenHash).startsWith("old-"), "the old link no longer works");
      assert.equal(hashLinkToken(readStoredLinkToken(r.rsvpToken as string)!), r.rsvpTokenHash, "the link shown is the one that works");
    }
  });
});

test("TS-261 (local database): 300 tables copied every way are exactly the source tables", { skip }, async () => {
  await rolledBack(async (q, sent) => {
    const owner = await newUser(q);
    const source = await newWedding(q, owner);
    const tables = layout(150);
    await insertRows(q, "seating_tables",
      ["id", "weddingId", "label", "capacity", "isRestricted", "isAccessible", "isLocked", "purpose", "purposeCriterionType", "purposeCriterionValue", "singleSideOnly", "shape", "positionX", "positionY", "updatedAt"],
      tables.map((t) => [randomUUID(), source, t.label, t.capacity, t.isRestricted, t.isAccessible, t.isLocked, t.purpose, t.purposeCriterionType, t.purposeCriterionValue, t.singleSideOnly, t.shape, t.positionX, t.positionY, new Date()]));

    // Save as a template: sortOrder 0..149 in number order.
    sent.reset();
    const template = await db.createTemplateFromWedding(owner, source, "TS-261 layout");
    counts.saveTemplate150 = sent.n;
    assert.ok(template);
    assert.deepEqual(template.tables.map((t) => t.sortOrder), tables.map((_, i) => i));
    assert.deepEqual(without(template.tables, "id", "templateId", "sortOrder"), tables);

    // A new wedding from it, and a duplicate of the source: the same 150 tables.
    sent.reset();
    const fromTemplate = await db.createWedding(owner, { name: "From template", templateId: template.id, applyTemplateTables: true });
    counts.createFromTemplate150 = sent.n;
    assert.deepEqual(await tablesOf(q, fromTemplate.id), byLabel(tables));
    sent.reset();
    const duplicate = await db.duplicateWeddingLayout(source, owner, "Duplicate");
    counts.duplicate150 = sent.n;
    assert.deepEqual(await tablesOf(q, duplicate!), byLabel(tables));

    // Applied to the source itself: 300 tables, the copies renamed " (2)".
    sent.reset();
    assert.equal(await db.addTemplateTablesToWedding(source, template.id, owner), 150);
    counts.applyTemplate150to300 = sent.n;
    assert.deepEqual(await tablesOf(q, source), byLabel([...tables, ...tables.map((t) => ({ ...t, label: `${t.label} (2)` }))]));

    // And a 300-table wedding saved, created from and duplicated -- the same statement counts as 150.
    sent.reset();
    const big = await db.createTemplateFromWedding(owner, source, "TS-261 big");
    assert.equal(sent.n, counts.saveTemplate150, "saving 300 tables takes as many statements as 150");
    counts.saveTemplate300 = sent.n;
    assert.equal(big!.tables.length, 300);
    sent.reset();
    const big2 = await db.createWedding(owner, { name: "Big", templateId: big!.id, applyTemplateTables: true });
    counts.createFromTemplate300 = sent.n;
    assert.equal(sent.n, counts.createFromTemplate150);
    assert.deepEqual(await tablesOf(q, big2.id), await tablesOf(q, source));
    sent.reset();
    const big3 = await db.duplicateWeddingLayout(source, owner, "Big duplicate");
    counts.duplicate300 = sent.n;
    assert.equal(sent.n, counts.duplicate150);
    assert.deepEqual(await tablesOf(q, big3!), await tablesOf(q, source));
    // Past the cap: refused, nothing added.
    await assert.rejects(db.addTemplateTablesToWedding(source, template.id, owner), db.WeddingCapError);
    assert.equal((await tablesOf(q, source)).length, 300);
  });
});

test("TS-261 (local database): quick-create of 100 tables -- names, places and order as before", { skip }, async () => {
  await rolledBack(async (q, sent) => {
    const owner = await newUser(q);
    const wedding = await newWedding(q, owner);
    await db.quickCreateSeatingTables(wedding, { count: 2, capacity: 8, shape: "ROUND", labelPrefix: "Table" });
    sent.reset();
    await db.quickCreateSeatingTables(wedding, { count: 3, capacity: 8, shape: "ROUND", labelPrefix: "Table" });
    const small = sent.n;
    sent.reset();
    const created = await db.quickCreateSeatingTables(wedding, { count: 100, capacity: 10, shape: "SQUARE", labelPrefix: "Table" });
    counts.quickCreate100 = sent.n;
    assert.equal(sent.n, small);
    assert.deepEqual(created.map((t) => t.label), Array.from({ length: 100 }, (_, i) => `Table ${i + 6}`));
    created.forEach((t, i) => {
      const index = 5 + i;
      assert.deepEqual([t.positionX, t.positionY, t.capacity, t.shape, t.isRestricted, t.purpose, t.revision], [40 + (index % 4) * 264, 40 + Math.floor(index / 4) * 240, 10, "SQUARE", false, null, 0]);
    });
    const listed = await db.listSeatingTablesForWedding(wedding);
    assert.deepEqual(listed.slice(5).map((t) => t.id), created.map((t) => t.id), "the rows returned are the rows saved, in the same order");
  });
});

test("TS-261 (local database): 20 members notified in one go -- the same people and words as one at a time", { skip }, async () => {
  await rolledBack(async (q, sent) => {
    const owner = await newUser(q);
    const wedding = await newWedding(q, owner);
    const collaborators: string[] = [];
    for (let i = 0; i < 20; i++) collaborators.push(await newUser(q));
    await insertRows(q, "wedding_collaborators", ["id", "weddingId", "userId"], collaborators.map((u) => [randomUUID(), wedding, u]));
    const outsider = await newUser(q);

    // The actor is collaborator 0, so the owner and the other 19 are told.
    sent.reset();
    await db.notifyWeddingCollaborators(wedding, collaborators[0], "GUEST_ADDED", "Ann Lee was added.");
    counts.notify20 = sent.n;
    const { rows } = await q.query(`SELECT "recipientUserId", type::text AS type, message, "isRead" FROM "notifications" WHERE "weddingId" = $1`, [wedding]);
    assert.deepEqual(rows.map((r) => r.recipientUserId).sort(), [owner, ...collaborators.slice(1)].sort());
    assert.ok(rows.every((r) => r.type === "GUEST_ADDED" && r.message === "Ann Lee was added." && r.isRead === false));

    // Directly: the same answer as the one-at-a-time check for a member, the owner, an outsider
    // and an account that doesn't exist.
    await q.query(`DELETE FROM "notifications" WHERE "weddingId" = $1`, [wedding]);
    const asked = [collaborators[3], owner, outsider, randomUUID()];
    const together = await db.insertNotifications(wedding, asked, "TABLE_CHANGED", "m");
    const { rows: togetherRows } = await q.query(`SELECT "recipientUserId" FROM "notifications" WHERE "weddingId" = $1`, [wedding]);
    await q.query(`DELETE FROM "notifications" WHERE "weddingId" = $1`, [wedding]);
    const oneByOne = new Set<string>();
    for (const u of asked) if (await db.insertNotification(wedding, u, "TABLE_CHANGED", "m")) oneByOne.add(u);
    const { rows: oneByOneRows } = await q.query(`SELECT "recipientUserId" FROM "notifications" WHERE "weddingId" = $1`, [wedding]);
    assert.deepEqual([...together].sort(), [...oneByOne].sort());
    assert.deepEqual(togetherRows.map((r) => r.recipientUserId).sort(), oneByOneRows.map((r) => r.recipientUserId).sort());
    assert.deepEqual([...together].sort(), [collaborators[3], owner].sort());
  });
});

test("TS-261 (local database): statement counts, then close the connection", { skip }, async () => {
  console.log(`[TS-261] statements sent: ${JSON.stringify(counts)}`);
  await (local as PgClient).end();
});
