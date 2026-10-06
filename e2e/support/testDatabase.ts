// TS-116: the few facts an e2e test can't reach through the app itself, read (or, for one case,
// set) directly in the local database.
//
// - An invite's token. The app deliberately never returns it over the API -- it exists only in the
//   invite email, and there's no inbox a test can read (email is a console stand-in locally and in
//   CI). Without it the accept flow, the one real way anyone joins a wedding, can't be driven.
//   TS-160: the database keeps only the token's hash, so the test plants a token it knows instead.
// - An invite's expiry. The 7-day expiry can't be waited out, so a test moves expiresAt into the
//   past.
//
// Same safety model as globalTeardown.ts: refuses outright if APP_URL resolves to a production
// hostname, and every statement is scoped to invites sent to this framework's own reserved test
// domain (@example.invalid), so a real invite can never be read or changed by a test.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { getEnv } from "./env";
import { isLocalDatabaseUrl, resolveIsProduction } from "./productionGuard";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "./auth";

/**
 * DATABASE_URL lives in the repo-root .env, which nothing in the Playwright process loads (the
 * app and Prisma CLI each load their own). Read it directly rather than adding a dotenv dependency
 * for one value. Returns undefined if it isn't found either way.
 */
export function resolveDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No root .env, or unreadable -- fall through to undefined.
  }
  return undefined;
}

let pool: Pool | undefined;

function testPool(): Pool {
  const env = getEnv();
  // TS-74: the same parsed list as the guard -- including KNOWN_PRODUCTION_HOSTNAMES.
  if (resolveIsProduction(env.APP_URL, env.PRODUCTION_HOSTNAMES)) {
    throw new Error(`testDatabase: refused -- ${env.APP_URL} resolves to a production hostname.`);
  }
  if (!pool) {
    const connectionString = resolveDatabaseUrl();
    if (!connectionString) {
      throw new Error("testDatabase: no DATABASE_URL in the environment or the root .env.");
    }
    // TS-172: never a database that isn't on this machine (or CI's), whatever APP_URL is.
    if (!isLocalDatabaseUrl(connectionString)) {
      throw new Error("testDatabase: refused -- DATABASE_URL isn't a local database.");
    }
    // One connection is plenty for a handful of lookups, and keeps a worker from holding a pool.
    // allowExitOnIdle so an idle connection never keeps a worker process alive.
    pool = new Pool({ connectionString, max: 1, allowExitOnIdle: true });
  }
  return pool;
}

const TEST_EMAIL_PATTERN = `%${TEST_ACCOUNT_EMAIL_DOMAIN}`;

const sha256Hex = async (text: string) => (await import("node:crypto")).createHash("sha256").update(text).digest("hex");

/**
 * A working token for an invite's accept link (`/invites/<token>`). TS-160: the app stores only a
 * SHA-256 hash of the emailed token, so -- like plantPasswordResetToken -- this gives the invite a
 * fresh token the test knows (replacing the emailed one) and returns it. Test invites only.
 */
export async function inviteToken(inviteId: string): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  const { rowCount } = await testPool().query(
    `UPDATE "wedding_invites" SET token = $1 WHERE id = $2 AND email LIKE $3`,
    [await sha256Hex(token), inviteId, TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no test invite ${inviteId}.`);
  return token;
}

/** TS-160: what an invite row stores in place of its token. */
export async function storedInviteToken(inviteId: string): Promise<string> {
  const { rows } = await testPool().query<{ token: string }>(
    `SELECT token FROM "wedding_invites" WHERE id = $1 AND email LIKE $2`,
    [inviteId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) throw new Error(`testDatabase: no test invite ${inviteId}.`);
  return rows[0].token;
}

/** Moves an invite's expiry one minute into the past, as if its 7 days had run out. */
export async function expireInvite(inviteId: string): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "wedding_invites" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1 AND email LIKE $2`,
    [inviteId, TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no test invite ${inviteId}.`);
}

/**
 * TS-142: plants a password-reset token for a *test* account (reserved domain only) and returns the
 * raw token -- the same thing the emailed link carries. The app only stores a SHA-256 hash, so the
 * test hashes it the same way. \`expired\` makes it an hour stale.
 */
export async function plantPasswordResetToken(email: string, { expired = false } = {}): Promise<string> {
  const { createHash, randomBytes, randomUUID } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  const { rowCount } = await testPool().query(
    `INSERT INTO "password_reset_tokens" (id, "userId", "tokenHash", "expiresAt")
     SELECT $1, id, $2, now() + ($3 || ' minutes')::interval FROM "users" WHERE email = $4 AND email LIKE $5`,
    [randomUUID(), createHash("sha256").update(token).digest("hex"), expired ? "-1" : "60", email.toLowerCase(), TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no test account ${email}.`);
  return token;
}

/** TS-142: how many still-usable reset links a test account has. */
export async function usableResetTokenCount(email: string): Promise<number> {
  const { rows } = await testPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "password_reset_tokens" t JOIN "users" u ON u.id = t."userId"
     WHERE u.email = $1 AND u.email LIKE $2 AND t."usedAt" IS NULL AND t."expiresAt" > now()`,
    [email.toLowerCase(), TEST_EMAIL_PATTERN],
  );
  return rows[0].n;
}

/** What a test guest's row stores for their RSVP link (TS-160: an encrypted copy and the hash). */
export async function storedGuestRsvpLink(guestId: string): Promise<{ stored: string | null; hash: string | null }> {
  const { rows } = await testPool().query<{ stored: string | null; hash: string | null }>(
    `SELECT g."rsvpToken" AS stored, g."rsvpTokenHash" AS hash FROM "guests" g
     JOIN "weddings" w ON w.id = g."weddingId" JOIN "users" u ON u.id = w."ownerId"
     WHERE g.id = $1 AND u.email LIKE $2`,
    [guestId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) throw new Error(`testDatabase: no guest ${guestId} on a test wedding.`);
  return rows[0];
}

/**
 * TS-143: which RSVP link a test guest currently has, or null if none has been made yet. TS-160:
 * this is the link's hash (the database no longer holds the token itself) -- enough to tell
 * whether a link exists and whether it has changed. The link itself comes from the rsvp-link API.
 */
export async function guestRsvpLinkFingerprint(guestId: string): Promise<string | null> {
  return (await storedGuestRsvpLink(guestId)).hash;
}

/** TS-160: what a test vendor's row stores for their share link. */
export async function storedVendorShareLink(vendorId: string): Promise<{ stored: string | null; hash: string | null }> {
  const { rows } = await testPool().query<{ stored: string | null; hash: string | null }>(
    `SELECT v."shareToken" AS stored, v."shareTokenHash" AS hash FROM "vendors" v
     JOIN "weddings" w ON w.id = v."weddingId" JOIN "users" u ON u.id = w."ownerId"
     WHERE v.id = $1 AND u.email LIKE $2`,
    [vendorId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) throw new Error(`testDatabase: no vendor ${vendorId} on a test wedding.`);
  return rows[0];
}

/**
 * TS-160: gives a test guest an RSVP link stored the way it was before TS-160 (token in plain text,
 * plus its hash, as the migration leaves it) and returns the token.
 */
export async function plantPreHashingRsvpLink(guestId: string): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  const { rowCount } = await testPool().query(
    `UPDATE "guests" g SET "rsvpToken" = $1, "rsvpTokenHash" = $2
     FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE g.id = $3 AND w.id = g."weddingId" AND u.email LIKE $4`,
    [token, await sha256Hex(token), guestId, TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no guest ${guestId} on a test wedding.`);
  return token;
}

/**
 * TS-163: how many times a test guest's responses have asked to email the planners this hour. Only
 * the first in the hour is emailed (the key's limit is 1), so 3 means one email and two skipped.
 */
export async function rsvpNotificationEmailRequests(guestId: string): Promise<number> {
  await storedGuestRsvpLink(guestId); // throws unless the guest is on a test wedding
  const { rows } = await testPool().query<{ n: number }>(
    `SELECT COALESCE(SUM(count), 0)::int AS n FROM "rate_limit_counters"
     WHERE key = $1 AND "windowStart" > now() - interval '1 hour'`,
    [`email:rsvp-notify:${guestId}`],
  );
  return rows[0].n;
}

/**
 * TS-164: marks a test account's email address as confirmed, as clicking the emailed link would.
 * The test-account sign-up helpers do this by default (most tests aren't about confirming email);
 * a test about confirmation signs up without it and uses plantEmailVerificationToken instead.
 */
export async function confirmTestAccountEmail(email: string): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "users" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()) WHERE email = $1 AND email LIKE $2`,
    [email.toLowerCase(), TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no test account ${email}.`);
}

/** TS-164: whether a test account has confirmed its email address. */
export async function testAccountEmailConfirmed(email: string): Promise<boolean> {
  const { rows } = await testPool().query<{ confirmed: boolean }>(
    `SELECT "emailVerifiedAt" IS NOT NULL AS confirmed FROM "users" WHERE email = $1 AND email LIKE $2`,
    [email.toLowerCase(), TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) throw new Error(`testDatabase: no test account ${email}.`);
  return rows[0].confirmed;
}

/**
 * TS-164: gives a test account a confirmation link the test knows (the emailed one can't be read --
 * only its hash is stored) and returns its token. Like plantPasswordResetToken.
 */
export async function plantEmailVerificationToken(email: string): Promise<string> {
  const { createHash, randomBytes, randomUUID } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  const { rowCount } = await testPool().query(
    `INSERT INTO "email_verification_tokens" (id, "userId", "tokenHash", "expiresAt")
     SELECT $1, id, $2, now() + interval '1 hour' FROM "users" WHERE email = $3 AND email LIKE $4`,
    [randomUUID(), createHash("sha256").update(token).digest("hex"), email.toLowerCase(), TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no test account ${email}.`);
  return token;
}

/**
 * TS-168: how many RSVP notification emails a test wedding has sent this hour (the per-wedding
 * counter is only touched for recipients who've confirmed their address and are being emailed).
 */
export async function weddingNotificationEmailsThisHour(weddingId: string): Promise<number> {
  const { rows: owned } = await testPool().query(
    `SELECT 1 FROM "weddings" w JOIN "users" u ON u.id = w."ownerId" WHERE w.id = $1 AND u.email LIKE $2`,
    [weddingId, TEST_EMAIL_PATTERN],
  );
  if (!owned[0]) throw new Error(`testDatabase: no test wedding ${weddingId}.`);
  const { rows } = await testPool().query<{ n: number }>(
    `SELECT COALESCE(SUM(count), 0)::int AS n FROM "rate_limit_counters"
     WHERE key = $1 AND "windowStart" > now() - interval '1 hour'`,
    [`email:notify-wedding:3600:${weddingId}`],
  );
  return rows[0].n;
}

/**
 * TS-173: resolves once `count` database sessions are waiting behind the session `pid` -- directly,
 * or queued behind a request that is (a second request for the same row waits on the first
 * waiter, not on the holder). Shared by the lock-holding helpers below.
 */
async function waitForSessionsBlockedBy(pid: number, count: number, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { rows: waiting } = await testPool().query<{ n: number }>(
      `WITH RECURSIVE blocked(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
       )
       SELECT COUNT(*)::int AS n FROM blocked`,
      [pid],
    );
    if (waiting[0].n >= count) return;
    if (Date.now() > deadline) throw new Error(`testDatabase: only ${waiting[0].n} of ${count} request(s) reached ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** TS-173: a test wedding's row lock, held from outside the app -- see holdWeddingLock. */
export interface HeldWeddingLock {
  /** Resolves once `count` of the app's own database sessions are waiting on this lock. */
  waitForWaiters(count: number): Promise<void>;
  /** Lets the waiting requests carry on. */
  release(): Promise<void>;
}

/**
 * TS-173: holds a test wedding's row lock (the one Generate, Restore, imports and attendance
 * changes take) so a test can pause those requests at exactly the point a race used to slip in,
 * change something meanwhile, then let them go. Uses its own connection, separate from the
 * lookups above. Test weddings only (owner at the reserved test domain).
 */
export async function holdWeddingLock(weddingId: string): Promise<HeldWeddingLock> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: resolveDatabaseUrl() });
  testPool(); // the same production refusal as every other helper here
  await client.connect();
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT w.id FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE w.id = $1 AND u.email LIKE $2 FOR UPDATE OF w`,
    [weddingId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) {
    await client.query("ROLLBACK");
    await client.end();
    throw new Error(`testDatabase: no test wedding ${weddingId}.`);
  }
  const { rows: me } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  const pid = me[0].pid;
  return {
    async waitForWaiters(count: number) {
      await waitForSessionsBlockedBy(pid, count, "the wedding lock");
    },
    async release() {
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}

/** TS-179: a test plan version's row lock, held from outside the app -- see holdPlanVersion. */
export interface HeldPlanVersion {
  /** Resolves once `count` of the app's own database sessions are waiting on this plan version. */
  waitForWaiters(count: number): Promise<void>;
  /** Marks the plan Approved (as an approval landing just first would) and lets the waiting requests carry on. */
  approveAndRelease(): Promise<void>;
  /** Lets the waiting requests carry on without changing anything (cleanup). */
  release(): Promise<void>;
}

/**
 * TS-179: holds a test plan version's row lock (the one a status change takes), so a status change
 * waits exactly where an approval landing at the same moment used to slip past the route's own
 * check; the test then approves the plan and lets the request go. Test weddings only.
 */
export async function holdPlanVersion(planVersionId: string): Promise<HeldPlanVersion> {
  const { Client } = await import("pg");
  testPool(); // the same production refusal as every other helper here
  const client = new Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT pv.id FROM "plan_versions" pv JOIN "weddings" w ON w.id = pv."weddingId" JOIN "users" u ON u.id = w."ownerId"
     WHERE pv.id = $1 AND u.email LIKE $2 FOR UPDATE OF pv`,
    [planVersionId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) {
    await client.query("ROLLBACK");
    await client.end();
    throw new Error(`testDatabase: no plan version ${planVersionId} on a test wedding.`);
  }
  const { rows: me } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  const pid = me[0].pid;
  let open = true;
  const finish = async (sql: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    open = false;
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  return {
    async waitForWaiters(count: number) {
      await waitForSessionsBlockedBy(pid, count, "the plan version");
    },
    async approveAndRelease() {
      await client.query(
        `UPDATE "plan_versions" SET status = 'APPROVED', "approvedAt" = now(), revision = revision + 1 WHERE id = $1`,
        [planVersionId],
      );
      await finish("COMMIT");
    },
    async release() {
      await finish("ROLLBACK");
    },
  };
}

/**
 * TS-174: makes a test wedding's timeline entries tie on position the way entries saved before
 * TS-153 could (every one at sortOrder 0), with their creation times in the given order -- the
 * first id earliest. Lets a test check that the list and "Up"/"Down" break such a tie the same way.
 */
export async function plantTimelineTie(weddingId: string, entryIdsInCreatedOrder: string[]): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "timeline_entries" t
     SET "sortOrder" = 0,
         "createdAt" = timestamp '2020-01-01' + (array_position($2::text[], t.id) * interval '1 minute')
     FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE t."weddingId" = $1 AND t.id = ANY($2::text[]) AND w.id = t."weddingId" AND u.email LIKE $3`,
    [weddingId, entryIdsInCreatedOrder, TEST_EMAIL_PATTERN],
  );
  if (rowCount !== entryIdsInCreatedOrder.length) throw new Error(`testDatabase: not every entry is on test wedding ${weddingId}.`);
}

/**
 * TS-181: clears every Needs Reassignment flag on a test wedding's plan version and marks it
 * complete -- what a plan looks like when a change was saved but its own re-check never ran. Lets
 * a test check that approving re-checks the seating itself rather than trusting the stored flags.
 */
export async function plantStaleSeatFlags(weddingId: string, planVersionId: string): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "plan_versions" pv SET "isComplete" = true
     FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE pv.id = $2 AND pv."weddingId" = $1 AND w.id = pv."weddingId" AND u.email LIKE $3`,
    [weddingId, planVersionId, TEST_EMAIL_PATTERN],
  );
  if (rowCount !== 1) throw new Error(`testDatabase: no plan version ${planVersionId} on test wedding ${weddingId}.`);
  await testPool().query(`UPDATE "seat_assignments" SET "needsReassignment" = false WHERE "planVersionId" = $1`, [planVersionId]);
}

/** TS-174: a test timeline entry's row lock, held from outside the app -- see holdTimelineEntry. */
export interface HeldTimelineEntry {
  /** Resolves once `count` of the app's own database sessions are waiting on this entry. */
  waitForWaiters(count: number): Promise<void>;
  /** Moves the entry to another time and lets the waiting requests carry on. */
  moveToTimeAndRelease(time: string): Promise<void>;
  /** Lets the waiting requests carry on without changing anything (cleanup). */
  release(): Promise<void>;
}

/**
 * TS-174: holds a test timeline entry's row lock, so a reorder of it waits exactly where a change
 * of its time used to slip in; the test then moves it and lets the reorder go. Test weddings only.
 */
export async function holdTimelineEntry(entryId: string): Promise<HeldTimelineEntry> {
  const { Client } = await import("pg");
  testPool(); // the same production refusal as every other helper here
  const client = new Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT t.id FROM "timeline_entries" t JOIN "weddings" w ON w.id = t."weddingId" JOIN "users" u ON u.id = w."ownerId"
     WHERE t.id = $1 AND u.email LIKE $2 FOR UPDATE OF t`,
    [entryId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) {
    await client.query("ROLLBACK");
    await client.end();
    throw new Error(`testDatabase: no timeline entry ${entryId} on a test wedding.`);
  }
  const { rows: me } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  const pid = me[0].pid;
  let open = true;
  const finish = async (sql: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    open = false;
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  return {
    async waitForWaiters(count: number) {
      await waitForSessionsBlockedBy(pid, count, "the timeline entry");
    },
    async moveToTimeAndRelease(time: string) {
      await client.query(`UPDATE "timeline_entries" SET time = $1, "updatedAt" = now() WHERE id = $2`, [time, entryId]);
      await finish("COMMIT");
    },
    async release() {
      await finish("ROLLBACK");
    },
  };
}

/**
 * TS-171: uses up all but `remaining` of a test network address's daily allowance of account
 * emails (sign-up confirmations, resent links and password resets), so a test can reach the limit
 * without a hundred real sign-ups. Test addresses only (198.18.0.0/15, see uniqueTestAddress).
 */
export async function useUpAccountEmailAllowance(address: string, limit: number, remaining: number): Promise<void> {
  if (!/^198\.(18|19)\.\d+\.\d+$/.test(address)) throw new Error(`testDatabase: ${address} isn't a test address.`);
  const day = 86_400_000;
  await testPool().query(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2, $3)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = $3`,
    [`account-email:addr:day:${address}`, new Date(Math.floor(Date.now() / day) * day), limit - remaining],
  );
}

/**
 * TS-177: the email limits a signed-in account's sends count against (apps/web/src/lib/rate-limit.ts
 * EMAIL_SEND_LIMITS, plus the account's daily allowance for every kind together), by the key and
 * window the app uses for each.
 */
export type AccountEmailCounter = "account-day" | "invites-hour" | "invites-day" | "rsvp-emails-hour";
const ACCOUNT_EMAIL_COUNTERS: Record<AccountEmailCounter, { prefix: string; windowSeconds: number }> = {
  "account-day": { prefix: "email:account:day:", windowSeconds: 86_400 },
  "invites-hour": { prefix: "email:invites:3600:", windowSeconds: 3600 },
  "invites-day": { prefix: "email:invites:86400:", windowSeconds: 86_400 },
  "rsvp-emails-hour": { prefix: "email:rsvpEmails:3600:", windowSeconds: 3600 },
};

async function testAccountId(email: string): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(`SELECT id FROM "users" WHERE email = $1 AND email LIKE $2`, [
    email.toLowerCase(),
    TEST_EMAIL_PATTERN,
  ]);
  if (!rows[0]) throw new Error(`testDatabase: no test account ${email}.`);
  return rows[0].id;
}

function currentWindowStart(windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(Date.now() / ms) * ms);
}

/** TS-177: how many emails a test account has counted against one of its limits in the current window. */
export async function accountEmailCount(email: string, counter: AccountEmailCounter): Promise<number> {
  const { prefix, windowSeconds } = ACCOUNT_EMAIL_COUNTERS[counter];
  const { rows } = await testPool().query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2`,
    [`${prefix}${await testAccountId(email)}`, currentWindowStart(windowSeconds)],
  );
  return rows[0]?.count ?? 0;
}

/** TS-177: sets a test account's count against one of its email limits, so a test can reach a limit
 * without sending a hundred emails. */
export async function setAccountEmailCount(email: string, counter: AccountEmailCounter, count: number): Promise<void> {
  const { prefix, windowSeconds } = ACCOUNT_EMAIL_COUNTERS[counter];
  await testPool().query(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2, $3)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = $3`,
    [`${prefix}${await testAccountId(email)}`, currentWindowStart(windowSeconds), count],
  );
}

/** TS-178: sets one counter's value in its current window. Every caller below checks first that the
 * key belongs to a test address or test account. */
async function setCounter(key: string, windowSeconds: number, count: number, window: "current" | "previous" = "current"): Promise<void> {
  const start = currentWindowStart(windowSeconds);
  // TS-184: "previous" is the window just before the current one, which shorter limits still count.
  if (window === "previous") start.setTime(start.getTime() - windowSeconds * 1000);
  await testPool().query(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2, $3)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = $3`,
    [key, start, count],
  );
}

async function readCounter(key: string, windowSeconds: number): Promise<number> {
  const { rows } = await testPool().query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2`,
    [key, currentWindowStart(windowSeconds)],
  );
  return rows[0]?.count ?? 0;
}

function requireTestEmail(email: string): string {
  const lowered = email.trim().toLowerCase();
  if (!lowered.endsWith(TEST_ACCOUNT_EMAIL_DOMAIN)) throw new Error(`testDatabase: ${email} isn't a test address.`);
  return lowered;
}

/**
 * TS-178: sets how many emails a test address has had from Seatwise today (the per-address daily
 * cap, EMAILS_PER_RECIPIENT_PER_DAY in packages/db/src/email.ts), so a test can reach the cap
 * without sending them. Test addresses (@example.invalid, no "+tag") only.
 */
export async function setEmailsToAddressToday(email: string, count: number): Promise<void> {
  const address = requireTestEmail(email);
  if (address.includes("+")) throw new Error("testDatabase: use a test address without a +tag.");
  await setCounter(`email:to:day:${address}`, 86_400, count);
}

/** TS-178: how many emails a test address has had from Seatwise today (see setEmailsToAddressToday). */
export async function emailsToAddressToday(email: string): Promise<number> {
  return readCounter(`email:to:day:${requireTestEmail(email)}`, 86_400);
}

/**
 * TS-178: sets a test account's count of wrong passwords from everywhere in the current window
 * (LOGIN_LIMITS.failuresPerAccount in apps/web/src/lib/rate-limit.ts) -- `count` at that limit
 * locks the account, as many wrong guesses would.
 */
export async function setSignInFailuresForAccount(
  email: string,
  count: number,
  window: "current" | "previous" = "current",
): Promise<void> {
  await testAccountId(email); // throws unless it's a test account
  await setCounter(`login:account:${requireTestEmail(email)}`, 900, count, window);
}

/** TS-178: the "Forgot password?" counters for one test email (PASSWORD_RESET_LIMITS), by window. */
export type PasswordResetCounter = "per-email-15-minutes" | "per-email-day";
const PASSWORD_RESET_COUNTERS: Record<PasswordResetCounter, { prefix: string; windowSeconds: number }> = {
  "per-email-15-minutes": { prefix: "pw-reset:email:", windowSeconds: 900 },
  "per-email-day": { prefix: "pw-reset:email:day:", windowSeconds: 86_400 },
};

export async function passwordResetCount(email: string, counter: PasswordResetCounter): Promise<number> {
  const { prefix, windowSeconds } = PASSWORD_RESET_COUNTERS[counter];
  return readCounter(`${prefix}${requireTestEmail(email)}`, windowSeconds);
}

export async function setPasswordResetCount(email: string, counter: PasswordResetCounter, count: number): Promise<void> {
  const { prefix, windowSeconds } = PASSWORD_RESET_COUNTERS[counter];
  await setCounter(`${prefix}${requireTestEmail(email)}`, windowSeconds, count);
}

/** TS-178: how many weddings a test account has created today (WEDDING_CREATE_LIMITS). */
export async function weddingsCreatedToday(email: string): Promise<number> {
  return readCounter(`weddings:create:day:${await testAccountId(email)}`, 86_400);
}
