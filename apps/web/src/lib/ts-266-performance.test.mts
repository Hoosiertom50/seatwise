// TS-266: unit tests for review 13's performance fixes.
//   1. Scripted stand-in database (always runs): a notification to 20 members is the same number of
//      statements as one to 3 -- one membership re-read and one reservation for all of them, not
//      about eight statements per recipient.
//   2. Local database, rolled back (runs only when the database in packages/db/.env, or DATABASE_URL,
//      is on this machine and reachable -- skipped otherwise, e.g. in CI's unit job): the batch
//      email counts give exactly the outcome the old one-email-at-a-time counts gave -- how many go,
//      which refusal the rest get, what stays counted -- including limits filling up part-way
//      through a batch, sends that fail (given back) and sends that may have gone out (kept); and
//      the plan version list's COUNT(*) is the old COUNT(DISTINCT).
//   3. A throwaway local database (created, migrated and dropped by the test): the "who is attending
//      but has no seat" checks on a freshly imported 2,000-guest wedding while Postgres's statistics
//      still describe the database as it was before (the case review 13 found took 150-400 ms a
//      check), with the same answers as before.
// Never connects anywhere but localhost. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";

const db = await import("@seatwise/db");
const { pool } = db;

type Rows = Record<string, unknown>[];
type Statement = { sql: string; params: unknown[] };

const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);
function restorePool() {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
}
afterEach(() => {
  restorePool();
  db.setEmailSenderForTests();
});

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, log, error } = console;
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
    console.error = error;
  }
}

// ---- 1. Scripted stand-in --------------------------------------------------------------------------

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);

/** A wedding with emails on and `n` collaborators (all confirmed, all wanting emails). */
function membersWithEmail(n: number): Statement[] {
  const log: Statement[] = [];
  const everyone = ["owner", ...ids("c", n)].map((id) => ({ id, email: `${id}@example.invalid`, emailVerifiedAt: new Date(), wantsEmail: true }));
  const run = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    log.push({ sql: text, params });
    let rows: Rows = [];
    if (/^SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings"/.test(text)) rows = [{ ownerId: "owner", name: "W", emailNotificationsEnabled: true }];
    else if (/UNION/.test(text)) rows = everyone;
    else if (/^SELECT "ownerId" FROM "weddings" WHERE id = \$1 FOR KEY SHARE$/.test(text)) rows = [{ ownerId: "owner" }];
    else if (/^SELECT id FROM "users" WHERE id = ANY/.test(text)) rows = (params[0] as string[]).map((id) => ({ id }));
    else if (/^SELECT "userId" FROM "wedding_collaborators" .* = ANY/.test(text)) rows = (params[1] as string[]).map((userId) => ({ userId }));
    else if (/^SELECT "createdAt" > now\(\)/.test(text)) rows = [{ isNew: false }];
    else if (/^SELECT u\.id, u\.email FROM "users" u WHERE u\.id = ANY/.test(text)) rows = everyone.filter((e) => (params[0] as string[]).includes(e.id));
    else if (/^INSERT INTO "rate_limit_counters" .* unnest/.test(text)) {
      rows = (params[0] as string[]).map((key, i) => ({ key, count: (params[2] as number[])[i] }));
    }
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
  return log;
}

test("TS-266: emailing 20 members is the same number of statements as emailing 3", async () => {
  process.env.EMAIL_TRANSPORT = "log";
  const small = membersWithEmail(3);
  await quietly(() => db.notifyWeddingCollaborators("w1", "c00000", "GUEST_ADDED", "Ann Lee was added."));
  const big = membersWithEmail(20);
  await quietly(() => db.notifyWeddingCollaborators("w1", "c00000", "GUEST_ADDED", "Ann Lee was added."));
  assert.equal(big.length, small.length, big.map((s) => s.sql.slice(0, 50)).join(" | "));
  const membership = big.filter((s) => /^SELECT u\.id, u\.email FROM "users" u/.test(s.sql));
  assert.equal(membership.length, 1, "one re-read of who still wants the email, for everyone");
  assert.equal((membership[0].params[0] as string[]).length, 20, "the owner and the 19 other collaborators");
  const counts = big.filter((s) => /rate_limit_counters/.test(s.sql));
  assert.equal(counts.length, 2, `one upsert and one read for all the counts: ${counts.map((s) => s.sql.slice(0, 40)).join(" | ")}`);
  assert.deepEqual((counts[0].params[2] as number[]), [20, 20, 20], "each limit counted once, for all 20");
});

// ---- 2. Local database, rolled back ---------------------------------------------------------------

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
type PgPool = Queryable & { connect: () => Promise<Queryable & { release: () => void }>; end: () => Promise<void> };
const pg = createRequire(import.meta.url)("pg") as {
  Client: new (o: { connectionString: string; connectionTimeoutMillis?: number }) => PgClient;
  Pool: new (o: { connectionString: string; max?: number }) => PgPool;
};

async function connectLocal(): Promise<PgClient | string> {
  const url = localDatabaseUrl();
  if (!url) return "no local database configured (DATABASE_URL must point at localhost)";
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query(`SELECT 1 FROM "rate_limit_counters" LIMIT 0`);
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    return `local database not reachable (${(err as Error & { code?: string }).code ?? (err as Error).message})`;
  }
}

const local = await connectLocal();
const skip = typeof local === "string" ? local : false;
after(async () => {
  if (typeof local !== "string") await local.end().catch(() => {});
});

/** Runs `fn` with the app's pool pointed at the local client, inside a transaction that is always rolled back. */
async function rolledBack(fn: (q: Queryable) => Promise<void>) {
  const q = local as PgClient;
  const run = async (sql: string, params?: unknown[]) => {
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
    await fn(q);
  } finally {
    restorePool();
    await q.query("ROLLBACK");
  }
}

const HOUR = 3_600_000;
const hourStart = (ms: number) => new Date(Math.floor(ms / HOUR) * HOUR);
/** Sets `key`'s stored count in the window starting `start` (UTC, as rate-limit.ts writes it). */
async function setCount(q: Queryable, key: string, start: Date, count: number) {
  await q.query(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2::timestamp, $3)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = EXCLUDED.count`,
    [key, start.toISOString(), count]
  );
}
async function totals(q: Queryable, keys: string[]): Promise<Record<string, number>> {
  const { rows } = await q.query(`SELECT key, SUM(count)::int AS n FROM "rate_limit_counters" WHERE key = ANY($1::text[]) GROUP BY key`, [keys]);
  return Object.fromEntries(keys.map((k) => [k, Number(rows.find((r) => r.key === k)?.n ?? 0)]));
}
async function clear(q: Queryable, keys: string[]) {
  await q.query(`DELETE FROM "rate_limit_counters" WHERE key = ANY($1::text[])`, [keys]);
}

test("TS-266 (local database): reserving notification emails together lets exactly as many go as one at a time, and keeps the same counts", { skip }, async () => {
  await rolledBack(async (q) => {
    const now = Date.now();
    const hour = hourStart(now);
    const counters = [
      // Sliding (hourly): what's in the previous hour still partly counts.
      { key: `ts266:hourly:${randomUUID()}`, limit: 30, windowSeconds: 3600 },
      // Rolling (a day): the earlier hours of the day count.
      { key: `ts266:daily:${randomUUID()}`, limit: 50, windowSeconds: 86_400 },
      { key: `ts266:owner:${randomUUID()}`, limit: 12, windowSeconds: 86_400 },
    ];
    const keys = counters.map((c) => c.key);
    // [already counted: this hour, previous hour] per counter, then how many emails are asked for.
    const scenarios: { name: string; before: [number, number][]; n: number }[] = [
      { name: "plenty of room", before: [[0, 0], [0, 0], [0, 0]], n: 20 },
      { name: "the owner's pool fills part-way", before: [[0, 0], [10, 0], [5, 0]], n: 20 },
      { name: "the hourly limit fills part-way (with last hour carried over)", before: [[20, 12], [0, 0], [0, 0]], n: 8 },
      { name: "the day's limit fills part-way (earlier hours of the day)", before: [[0, 0], [3, 44], [0, 0]], n: 6 },
      { name: "already full", before: [[30, 0], [0, 0], [0, 0]], n: 4 },
      { name: "over the limit already", before: [[0, 0], [0, 0], [15, 0]], n: 3 },
    ];
    for (const s of scenarios) {
      const prepare = async () => {
        await clear(q, keys);
        for (const [i, [current, earlier]] of s.before.entries()) {
          if (current) await setCount(q, keys[i], hour, current);
          // Previous window for the sliding one; three hours back (well inside the day) for the rolling ones.
          if (earlier) await setCount(q, keys[i], new Date(hour.getTime() - (counters[i].windowSeconds < 86_400 ? HOUR : 3 * HOUR)), earlier);
        }
      };
      await prepare();
      let oneAtATime = 0;
      for (let i = 0; i < s.n; i++) if ((await db.reserveNotificationEmail(counters)).allowed) oneAtATime++;
      const oldCounts = await totals(q, keys);

      await prepare();
      const together = await db.reserveNotificationEmails(counters, s.n);
      assert.equal(together.allowed, oneAtATime, `${s.name}: how many may go`);
      assert.deepEqual(await totals(q, keys), oldCounts, `${s.name}: what stays counted`);

      // Giving back emails that didn't go out takes exactly that many off each limit.
      if (together.allowed >= 2) {
        await together.giveBack(2);
        const back = await totals(q, keys);
        for (const k of keys) assert.equal(back[k], oldCounts[k] - 2, `${s.name}: given back on ${k}`);
        await together.giveBack(together.allowed + 5);
        const all = await totals(q, keys);
        for (const k of keys) assert.equal(all[k], oldCounts[k] - together.allowed, `${s.name}: never more than was allowed`);
      }
    }
  });
});

test("TS-266 (local database): emailing members together gives the same results and counts as one email at a time", { skip }, async () => {
  await rolledBack(async (q) => {
    // A small everyday allowance, so the shares fill up part-way through a batch: everyday 20,
    // 4 kept for invites and RSVP links (16 for notifications), account share 5, guests' answers 4,
    // first-week accounts' notifications 4.
    const env = { NODE_ENV: "production", SMTP_USER: "seatwise.test@example.test", SMTP_PASSWORD: "x", EMAIL_DAILY_LIMIT: "20" };
    const limits = db.dailyEmailLimits(env);
    assert.deepEqual([limits.everyday - limits.plannerFloor, limits.accountShare, limits.guestAnswers, limits.newAccountNotifications], [16, 5, 4, 4]);
    const settled = randomUUID();
    const fresh = randomUUID();
    await q.query(
      `INSERT INTO "users" (id, email, "passwordHash", name, "createdAt", "updatedAt") VALUES
         ($1, $2, 'x', 'TS-266 settled', now() - interval '30 days', now()), ($3, $4, 'x', 'TS-266 new', now(), now())`,
      [settled, `ts266-${settled}@example.test`, fresh, `ts266-${fresh}@example.test`]
    );
    const everyday = "email:global:24h:everyday";
    const keys = [everyday, db.accountShareKey(settled), db.accountShareKey(fresh), "email:global:24h:guest-answers", "email:global:24h:new-account-notifications"];
    const hour = hourStart(Date.now());
    const to = Array.from({ length: 8 }, (_, i) => `member${i}@example.test`);
    let failing = new Set<string>();
    let unsure = new Set<string>();
    let sent: string[] = [];
    db.setEmailSenderForTests(async (_config, message) => {
      if (failing.has(message.to)) throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
      if (unsure.has(message.to)) throw Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
      sent.push(message.to);
    });

    const scenarios: { name: string; charge: { account?: string; forGuestsOf?: string }; before: Record<string, number>; fail?: number[]; uncertain?: number[] }[] = [
      { name: "an established planner, room for all", charge: { account: settled }, before: {} },
      { name: "an established planner's share fills part-way", charge: { account: settled }, before: { [db.accountShareKey(settled)]: 2 } },
      { name: "the everyday allowance fills part-way", charge: { account: settled }, before: { [everyday]: 13 } },
      { name: "a first-week planner (its share and the first-week share)", charge: { account: fresh }, before: { "email:global:24h:new-account-notifications": 1 } },
      { name: "a guest's answer (guests' answers share)", charge: { forGuestsOf: settled }, before: { "email:global:24h:guest-answers": 1 } },
      { name: "some sends fail, one may have gone", charge: { account: settled }, before: {}, fail: [0, 2], uncertain: [3] },
      { name: "everything already full", charge: { forGuestsOf: settled }, before: { [everyday]: 16 } },
    ];
    for (const s of scenarios) {
      const prepare = async () => {
        await clear(q, keys);
        for (const [k, v] of Object.entries(s.before)) await setCount(q, k, hour, v);
        failing = new Set((s.fail ?? []).map((i) => to[i]));
        unsure = new Set((s.uncertain ?? []).map((i) => to[i]));
        sent = [];
      };
      await prepare();
      const oneAtATime: string[] = [];
      for (const address of to) oneAtATime.push(await quietly(() => db.sendEmail(address, "S", "T", env, { toWeddingMember: true, ...s.charge })));
      const oldSent = sent;
      const oldCounts = await totals(q, keys);

      await prepare();
      const together = await quietly(() => db.sendEmailsToWeddingMembers(to, "S", "T", env, s.charge));
      assert.deepEqual(together, oneAtATime, `${s.name}: each address's result`);
      assert.deepEqual([...sent].sort(), [...oldSent].sort(), `${s.name}: who was emailed`);
      assert.deepEqual(await totals(q, keys), oldCounts, `${s.name}: what stays counted`);
    }

    // The log transport (local development, CI) prints them and counts nothing, as before.
    await clear(q, keys);
    const logged = await quietly(() => db.sendEmailsToWeddingMembers(to, "S", "T", { EMAIL_TRANSPORT: "log" }, { account: settled }));
    assert.deepEqual(logged, to.map(() => "logged"));
    assert.deepEqual(Object.values(await totals(q, keys)), keys.map(() => 0));
  });
});

test("TS-266 (local database, PR #114 review): a batch held back by its account's share never sits on the site-wide count, even for a moment", { skip }, async () => {
  await rolledBack(async (q) => {
    const env = { NODE_ENV: "production", SMTP_USER: "seatwise.test@example.test", SMTP_PASSWORD: "x", EMAIL_DAILY_LIMIT: "20" };
    const settled = randomUUID();
    await q.query(
      `INSERT INTO "users" (id, email, "passwordHash", name, "createdAt", "updatedAt") VALUES ($1, $2, 'x', 'TS-266 settled', now() - interval '30 days', now())`,
      [settled, `ts266-${settled}@example.test`]
    );
    const everyday = "email:global:24h:everyday";
    const share = db.accountShareKey(settled);
    await clear(q, [everyday, share]);
    const hour = hourStart(Date.now());
    await setCount(q, everyday, hour, 3);
    await setCount(q, share, hour, 3); // 2 of this account's 5 left
    db.setEmailSenderForTests(async () => {});
    // After every statement the batch makes, look at the site-wide count: it may rise only by the
    // emails that passed the account's share (2), never by the whole batch (8).
    let highest = 0;
    const everydayNow = async () => (await totals(q, [everyday]))[everyday];
    const watch = (run: (sql: string, params?: unknown[]) => Promise<unknown>) => async (sql: string, params?: unknown[]) => {
      const result = await run(sql, params);
      highest = Math.max(highest, await everydayNow());
      return result;
    };
    const p = pool as unknown as { connect: () => Promise<{ query: (s: string, p?: unknown[]) => Promise<unknown>; release: () => void }>; query: (s: string, p?: unknown[]) => Promise<unknown> };
    const inner = p.connect;
    p.connect = async () => {
      const c = await inner();
      return { ...c, query: watch(c.query) };
    };
    p.query = watch(p.query);
    const to = Array.from({ length: 8 }, (_, i) => `member${i}@example.test`);
    const results = await quietly(() => db.sendEmailsToWeddingMembers(to, "S", "T", env, { account: settled }));
    assert.equal(results.filter((r) => r === "sent").length, 2);
    assert.equal(highest, 5, "the site-wide count only ever held the 2 that went (3 + 2)");
    assert.equal(await everydayNow(), 5);
  });
});

test("TS-266 (local database): a notification to 8 members with room for 5 emails sends 5, as one at a time did -- even with a send failing", { skip }, async () => {
  const saved = { ...process.env };
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.EMAIL_DAILY_LIMIT;
  Object.assign(process.env, { SMTP_USER: "seatwise.test@example.test", SMTP_PASSWORD: "x" });
  try {
    await rolledBack(async (q) => {
      const owner = randomUUID();
      const members = Array.from({ length: 8 }, () => randomUUID());
      for (const id of [owner, ...members]) {
        await q.query(
          `INSERT INTO "users" (id, email, "passwordHash", name, "emailVerifiedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, 'x', 'TS-266 test', now(), now() - interval '30 days', now())`,
          [id, `ts266-${id}@example.test`]
        );
      }
      const wedding = randomUUID();
      await q.query(`INSERT INTO "weddings" (id, "ownerId", name, "emailNotificationsEnabled", "updatedAt") VALUES ($1, $2, 'TS-266 test wedding', true, now())`, [wedding, owner]);
      for (const m of members) await q.query(`INSERT INTO "wedding_collaborators" (id, "weddingId", "userId") VALUES ($1, $2, $3)`, [randomUUID(), wedding, m]);
      const counters = await db.notificationEmailCounters(owner, wedding, owner);
      const keys = [...counters.map((c) => c.key), db.accountShareKey(owner), "email:global:24h:everyday"];
      const hourlyKey = counters.find((c) => c.windowSeconds === 3600)!.key;
      const failingAddress = `ts266-${members[2]}@example.test`;
      let sent = 0;
      db.setEmailSenderForTests(async (_config, message) => {
        if (message.to === failingAddress) throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
        sent++;
      });
      const prepare = async () => {
        await clear(q, keys);
        await setCount(q, hourlyKey, hourStart(Date.now()), 55); // the owner's hourly 60: room for 5
        sent = 0;
      };

      // The old way, one recipient at a time: reserve, send, give back what didn't go.
      await prepare();
      for (const m of members) {
        const reservation = await db.reserveNotificationEmail(counters);
        if (!reservation.allowed) continue;
        const result = await quietly(() => db.sendEmail(`ts266-${m}@example.test`, "S", "T", process.env, { toWeddingMember: true, account: owner }));
        if (!db.emailMayHaveGone(result)) await reservation.giveBack();
      }
      const oldSent = sent;
      const oldCounts = await totals(q, keys);

      await prepare();
      await quietly(() => db.notifyWeddingCollaborators(wedding, owner, "STATUS_CHANGED", "The plan was approved."));
      assert.equal(oldSent, 5);
      assert.equal(sent, oldSent, "the same number emailed");
      assert.deepEqual(await totals(q, keys), oldCounts, "the same counts kept");
    });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("TS-266 (local database): the plan version list counts each version's seated guests as before", { skip }, async () => {
  await rolledBack(async (q) => {
    const owner = randomUUID();
    await q.query(`INSERT INTO "users" (id, email, "passwordHash", name, "updatedAt") VALUES ($1, $2, 'x', 'TS-266 test', now())`, [owner, `ts266-${owner}@example.test`]);
    const wedding = randomUUID();
    await q.query(`INSERT INTO "weddings" (id, "ownerId", name, "updatedAt") VALUES ($1, $2, 'TS-266 test wedding', now())`, [wedding, owner]);
    const table = randomUUID();
    await q.query(`INSERT INTO "seating_tables" (id, "weddingId", label, capacity, "updatedAt") VALUES ($1, $2, 'Table 1', 500, now())`, [table, wedding]);
    const guests = Array.from({ length: 60 }, () => randomUUID());
    for (const [i, g] of guests.entries()) {
      await q.query(`INSERT INTO "guests" (id, "weddingId", "firstName", "lastName", "dayOfAttendance", "updatedAt") VALUES ($1, $2, 'G', $3, $4, now())`, [
        g,
        wedding,
        `N${i}`,
        i % 7 === 0 ? "NOT_ATTENDING" : "ATTENDING",
      ]);
    }
    for (let v = 1; v <= 4; v++) {
      const pv = randomUUID();
      await q.query(`INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", "isCurrent") VALUES ($1, $2, $3, $4)`, [pv, wedding, v, v === 4]);
      for (const g of guests.slice(0, 10 * v + 5)) {
        await q.query(`INSERT INTO "seat_assignments" (id, "planVersionId", "guestId", "seatingTableId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [randomUUID(), pv, g, table]);
      }
    }
    const listed = await db.listPlanVersionsForWedding(wedding);
    const { rows: distinct } = await q.query(
      `SELECT p."versionNumber", COUNT(DISTINCT sa."guestId")::int AS n FROM "seat_assignments" sa
         JOIN "guests" g ON g.id = sa."guestId" AND g."dayOfAttendance" = 'ATTENDING'
         JOIN "plan_versions" p ON p.id = sa."planVersionId" AND p."weddingId" = $1 GROUP BY p."versionNumber"`,
      [wedding]
    );
    assert.equal(listed.length, 4);
    for (const v of listed) {
      assert.equal(v.assignedGuestCount, Number(distinct.find((d) => d.versionNumber === v.versionNumber)?.n ?? 0), `version ${v.versionNumber}`);
    }
    // Version 1 seats guests 0-14, of whom 0, 7 and 14 aren't attending.
    assert.equal(listed.find((v) => v.versionNumber === 1)?.assignedGuestCount, 12);
  });
});

// ---- 3. A throwaway database with stale statistics ------------------------------------------------

// Generous: the old checks took 150-400 ms each here; the new ones take a few.
const CHECK_MS = 60;
// Generate's save (2,000 seats written, plus the checks): ~650 ms before, ~150 ms after.
const SAVE_MS = 400;

const OLD_UNASSIGNED = `SELECT COUNT(*)::int AS n FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
  AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = $2 AND sa."guestId" = g.id)`;
const NEW_UNASSIGNED = `SELECT COUNT(*)::int AS n FROM "guests" g WHERE g."weddingId" = $1 AND g."dayOfAttendance" = 'ATTENDING'
  AND g.id NOT IN (SELECT sa."guestId" FROM "seat_assignments" sa WHERE sa."planVersionId" = $2)`;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

test("TS-266 (throwaway local database): unseated-guest checks stay fast on a new 2,000-guest wedding with stale statistics, with the same answers", { skip, timeout: 120_000 }, async () => {
  const admin = local as PgClient;
  const name = `zz_ts266_${randomBytes(4).toString("hex")}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    // Not allowed to create databases here: nothing to clean up, nothing tested.
    console.log(`[TS-266] skipped the stale-statistics check: can't create a database (${(err as { code?: string }).code ?? (err as Error).message})`);
    return;
  }
  const url = new URL(localDatabaseUrl()!);
  url.pathname = `/${name}`;
  assert.ok(LOCAL_HOSTS.has(url.hostname));
  const throwaway = new pg.Pool({ connectionString: url.toString(), max: 4 });
  const timings: Record<string, number> = {};
  try {
    // The app's schema, from its migrations.
    const dir = path.join(import.meta.dirname, "../../../../packages/db/prisma/migrations");
    for (const m of readdirSync(dir).filter((d) => /^\d/.test(d)).sort()) {
      await throwaway.query(readFileSync(path.join(dir, m, "migration.sql"), "utf8"));
    }
    // Statistics stay as they're made below (autovacuum would bring them up to date later).
    for (const t of ["users", "weddings", "guests", "seating_tables", "plan_versions", "seat_assignments"]) {
      await throwaway.query(`ALTER TABLE "${t}" SET (autovacuum_enabled = false)`);
    }
    const insertMany = async (table: string, columns: string[], rows: unknown[][]) => {
      for (let start = 0; start < rows.length; start += 500) {
        const params: unknown[] = [];
        const tuples = rows.slice(start, start + 500).map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(", ")}, now())`);
        await throwaway.query(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}, "updatedAt") VALUES ${tuples.join(", ")}`, params);
      }
    };
    const owner = randomUUID();
    await insertMany("users", ["id", "email", "passwordHash", "name"], [[owner, "owner@ts266.example.test", "x", "Owner"]]);
    // A few small weddings, each with a plan -- then the statistics are made.
    for (let w = 0; w < 3; w++) {
      const wid = randomUUID();
      const tid = randomUUID();
      const pv = randomUUID();
      await insertMany("weddings", ["id", "ownerId", "name"], [[wid, owner, `Small ${w}`]]);
      await insertMany("seating_tables", ["id", "weddingId", "label", "capacity"], [[tid, wid, "Table 1", 30]]);
      const guests = Array.from({ length: 20 }, () => randomUUID());
      await insertMany("guests", ["id", "weddingId", "firstName", "lastName"], guests.map((g, i) => [g, wid, "S", `G${i}`]));
      await throwaway.query(`INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", "isCurrent") VALUES ($1, $2, 1, true)`, [pv, wid]);
      await insertMany("seat_assignments", ["id", "planVersionId", "guestId", "seatingTableId"], guests.map((g) => [randomUUID(), pv, g, tid]));
    }
    await throwaway.query("ANALYZE");

    // Then a big wedding is imported and planned, with no new statistics.
    const wedding = randomUUID();
    await insertMany("weddings", ["id", "ownerId", "name"], [[wedding, owner, "Big"]]);
    const tables = Array.from({ length: 250 }, () => randomUUID());
    await insertMany("seating_tables", ["id", "weddingId", "label", "capacity"], tables.map((t, i) => [t, wedding, `Table ${i + 1}`, 10]));
    const guests = Array.from({ length: 2000 }, (_, i) => ({ id: randomUUID(), attending: i % 20 !== 19 }));
    await insertMany(
      "guests",
      ["id", "weddingId", "firstName", "lastName", "dayOfAttendance"],
      guests.map((g, i) => [g.id, wedding, "B", `G${i}`, g.attending ? "ATTENDING" : "NOT_ATTENDING"])
    );
    const attending = guests.filter((g) => g.attending);
    const v1 = randomUUID();
    await throwaway.query(`INSERT INTO "plan_versions" (id, "weddingId", "versionNumber", "isCurrent") VALUES ($1, $2, 1, true)`, [v1, wedding]);
    // Everyone attending but the last 40 has a seat (8 to a table).
    const seated = attending.slice(0, attending.length - 40);
    await insertMany("seat_assignments", ["id", "planVersionId", "guestId", "seatingTableId"], seated.map((g, i) => [randomUUID(), v1, g.id, tables[Math.floor(i / 8)]]));

    // The app's pool, pointed at the throwaway database.
    (pool as unknown as { connect: unknown }).connect = () => throwaway.connect();
    (pool as unknown as { query: unknown }).query = (text: string, params?: unknown[]) => throwaway.query(text, params);

    // The query itself: the old form is the slow one here (logged, not asserted -- it depends on
    // the planner); the new one is fast and gives the same number.
    const oldForm = await timed(() => throwaway.query(OLD_UNASSIGNED, [wedding, v1]));
    const newForm = await timed(() => throwaway.query(NEW_UNASSIGNED, [wedding, v1]));
    timings["old NOT EXISTS form"] = oldForm.ms;
    timings["new NOT IN form"] = newForm.ms;
    assert.equal(newForm.value.rows[0].n, 40);
    assert.equal(oldForm.value.rows[0].n, newForm.value.rows[0].n);
    assert.ok(newForm.ms < CHECK_MS, `unassigned count took ${Math.round(newForm.ms)} ms`);

    // refreshPlanCompleteness (seat-checks.ts) -- every seat re-check.
    const client = await throwaway.connect();
    try {
      await client.query("BEGIN");
      const refresh = await timed(() => db.refreshPlanCompleteness(client as never, wedding, v1, { bumpRevision: false }));
      timings.refreshPlanCompleteness = refresh.ms;
      await client.query("COMMIT");
      assert.ok(refresh.ms < CHECK_MS, `refreshPlanCompleteness took ${Math.round(refresh.ms)} ms`);
    } finally {
      client.release();
    }
    assert.equal((await throwaway.query(`SELECT "isComplete" FROM "plan_versions" WHERE id = $1`, [v1])).rows[0].isComplete, false, "40 attending guests have no seat");

    // recomputeCurrentPlanCompleteness (plan-versions.ts).
    const recompute = await timed(() => db.recomputeCurrentPlanCompleteness(wedding, { unassignedMayHaveChanged: true }));
    timings.recomputeCurrentPlanCompleteness = recompute.ms;
    assert.ok(recompute.ms < CHECK_MS, `recomputeCurrentPlanCompleteness took ${Math.round(recompute.ms)} ms`);

    // Generate's save: a new version the statistics have never seen, holding a seat for every
    // attending guest and for 30 who aren't attending (they declined while it was worked out) --
    // those 30 are dropped, and the history counts the rest.
    const notAttending = guests.filter((g) => !g.attending).slice(0, 30);
    const assignments = [...attending, ...notAttending].map((g, i) => ({ guestId: g.id, tableId: tables[Math.floor(i / 8) % tables.length] }));
    const save = await timed(() =>
      db.createPlanVersionWithAssignments(wedding, { isComplete: true, warnings: [], assignments, unassignedGuestIds: [] })
    );
    timings["createPlanVersionWithAssignments (2,030 seats)"] = save.ms;
    const v2 = save.value.planVersionId;
    const { rows: kept } = await throwaway.query(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE g."dayOfAttendance" <> 'ATTENDING')::int AS "notAttending"
         FROM "seat_assignments" sa JOIN "guests" g ON g.id = sa."guestId" WHERE sa."planVersionId" = $1`,
      [v2]
    );
    assert.deepEqual(kept[0], { n: attending.length, notAttending: 0 }, "the not-attending guests' seats are dropped, every other one kept");
    assert.ok(save.ms < SAVE_MS, `saving the generated plan took ${Math.round(save.ms)} ms`);
    const { rows: plan } = await throwaway.query(`SELECT "isComplete" FROM "plan_versions" WHERE id = $1`, [v2]);
    assert.equal(plan[0].isComplete, true);

    // The new version, checked again with the new forms: nobody attending is unseated.
    const onV2 = await timed(() => throwaway.query(NEW_UNASSIGNED, [wedding, v2]));
    assert.equal(onV2.value.rows[0].n, 0);
    assert.equal((await throwaway.query(OLD_UNASSIGNED, [wedding, v2])).rows[0].n, 0);

    // A move on the new version (plan-versions.ts's own count after a move).
    const mover = attending[0].id;
    const emptyTable = tables[tables.length - 1];
    const move = await timed(() => db.moveGuestAssignment(v2, wedding, mover, emptyTable, owner));
    timings.moveGuestAssignment = move.ms;
    assert.equal(move.value.planVersion.isComplete, true);
    assert.equal(move.value.planVersion.assignments.find((a: { guestId: string }) => a.guestId === mover)?.tableId, emptyTable);
    assert.ok(move.ms < 4 * CHECK_MS, `the move took ${Math.round(move.ms)} ms`);

    console.log(`[TS-266] stale statistics, 2,000 guests: ${Object.entries(timings).map(([k, v]) => `${k} ${Math.round(v)} ms`).join("; ")}`);
  } finally {
    restorePool();
    await throwaway.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
});
