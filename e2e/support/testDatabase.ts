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

/**
 * TS-203: whether a test invite's email went out (the app records when). Accepting one that did
 * confirms the account's address; `setInviteEmailed(id, false)` makes it like an invite whose email
 * failed, whose link the owner copied and sent some other way.
 */
export async function inviteWasEmailed(inviteId: string): Promise<boolean> {
  const { rows } = await testPool().query<{ emailed: boolean }>(
    `SELECT "emailedAt" IS NOT NULL AS emailed FROM "wedding_invites" WHERE id = $1 AND email LIKE $2`,
    [inviteId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) throw new Error(`testDatabase: no test invite ${inviteId}.`);
  return rows[0].emailed;
}

export async function setInviteEmailed(inviteId: string, emailed: boolean): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "wedding_invites" SET "emailedAt" = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1 AND email LIKE $2`,
    [inviteId, TEST_EMAIL_PATTERN, emailed],
  );
  if (!rowCount) throw new Error(`testDatabase: no test invite ${inviteId}.`);
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
    // TS-187: in UTC, as the app now stores and compares it (whatever the database's time zone).
    `UPDATE "wedding_invites" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1 AND email LIKE $2`,
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
 * TS-163: how many times a test guest's repeated (unchanged) responses have emailed the planners
 * in the last hour. TS-186: the app keeps one row per email sent (the moment it was sent), and
 * responses held back by the once-an-hour rule add nothing -- so this is at most 1.
 */
export async function rsvpNotificationEmailRequests(guestId: string): Promise<number> {
  await storedGuestRsvpLink(guestId); // throws unless the guest is on a test wedding
  const { rows } = await testPool().query<{ n: number }>(
    `SELECT COALESCE(SUM(count), 0)::int AS n FROM "rate_limit_counters"
     WHERE key = $1 AND "windowStart" > $2::timestamp`,
    [`email:rsvp-notify:${guestId}`, utc(new Date(Date.now() - 3_600_000))],
  );
  return rows[0].n;
}

/**
 * TS-186: when a test guest was emailed their RSVP link, as the app's once-an-hour rule keeps it
 * (one row per email, for whichever link the guest had then), oldest first.
 */
export async function rsvpLinkEmailTimes(guestId: string): Promise<Date[]> {
  await storedGuestRsvpLink(guestId); // throws unless the guest is on a test wedding
  const { rows } = await testPool().query<{ startMs: number }>(
    `SELECT (EXTRACT(EPOCH FROM "windowStart") * 1000)::float8 AS "startMs" FROM "rate_limit_counters"
     WHERE key LIKE $1 AND count > 0 ORDER BY "windowStart"`,
    [`email:rsvp-link:${guestId}:%`],
  );
  return rows.map((r) => new Date(Number(r.startMs)));
}

/**
 * TS-186: moves a test guest's RSVP-link email times `minutes` into the past -- as if that much
 * time had gone by -- so a test can reach the end of the hour without waiting for it.
 */
export async function moveRsvpLinkEmailTimesBack(guestId: string, minutes: number): Promise<void> {
  await storedGuestRsvpLink(guestId);
  await testPool().query(
    `UPDATE "rate_limit_counters" SET "windowStart" = "windowStart" - make_interval(mins => $2)
     WHERE key LIKE $1`,
    [`email:rsvp-link:${guestId}:%`, minutes],
  );
}

/**
 * TS-186: sets how many of a test guest's changed RSVP answers have been emailed to the planners
 * today (CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY in packages/db/src/queries/notifications.ts).
 */
export async function setChangedRsvpEmailsToday(guestId: string, count: number): Promise<void> {
  await storedGuestRsvpLink(guestId);
  await setCounter(`email:rsvp-changed:day:${guestId}`, 86_400, count);
}

/** TS-186: sets how much of a test wedding's daily pool for guests' RSVP emails has been used today. */
export async function setWeddingNotificationEmailsToday(weddingId: string, count: number): Promise<void> {
  await weddingNotificationEmailsThisHour(weddingId); // throws unless it's a test wedding
  await setCounter(`email:notify-wedding:86400:${weddingId}`, 86_400, count);
}

/** TS-186: how many of a test guest's changed RSVP answers have been emailed today. */
export async function changedRsvpEmailsToday(guestId: string): Promise<number> {
  await storedGuestRsvpLink(guestId);
  return readCounter(`email:rsvp-changed:day:${guestId}`, 86_400);
}

/**
 * TS-186: how many emails nobody signed in set off (guests' RSVPs) a test wedding has sent today,
 * out of its own daily pool (NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR).
 */
export async function weddingNotificationEmailsToday(weddingId: string): Promise<number> {
  await weddingNotificationEmailsThisHour(weddingId); // throws unless it's a test wedding
  return readCounter(`email:notify-wedding:86400:${weddingId}`, 86_400);
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
     WHERE key = $1 AND "windowStart" > (now() AT TIME ZONE 'UTC') - interval '1 hour'`,
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
  /** TS-204: marks one of the wedding's plan versions Approved while the lock is still held (an
   * approval also takes the wedding's lock now, so it can't land from the app meanwhile), then lets
   * the waiting requests carry on. */
  approvePlanAndRelease(planVersionId: string): Promise<void>;
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
     WHERE w.id = $1 AND u.email LIKE $2 FOR NO KEY UPDATE OF w`,
    [weddingId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) {
    await client.query("ROLLBACK");
    await client.end();
    throw new Error(`testDatabase: no test wedding ${weddingId}.`);
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
      await waitForSessionsBlockedBy(pid, count, "the wedding lock");
    },
    async approvePlanAndRelease(planVersionId: string) {
      await client.query(
        `UPDATE "plan_versions" SET status = 'APPROVED', "approvedAt" = now(), revision = revision + 1 WHERE id = $1 AND "weddingId" = $2`,
        [planVersionId, weddingId],
      );
      await finish("COMMIT");
    },
    async release() {
      await finish("ROLLBACK");
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

/** TS-187: a wedding hand-off paused half-way, from outside the app -- see holdOwnershipHandOff. */
export interface HeldHandOff {
  /** Resolves once `count` of the app's own database sessions are waiting (directly or in turn) on this hold. */
  waitForWaiters(count: number): Promise<void>;
  /** Lets the paused hand-off finish. */
  release(): Promise<void>;
}

/**
 * TS-187: pauses a hand-off of a test wedding half-way -- after it has made the collaborator the
 * owner, before it's saved. A hand-off's last step adds the old owner back as an Edit collaborator,
 * which makes the database check the old owner's account is there (a share lock on its row); this
 * holds that account row locked, so that step waits. release() lets it go and the hand-off finishes
 * as normal. Test weddings and accounts only.
 * TS-204: it used to hold an unsaved collaborator row for the old owner instead -- but adding that
 * row share-locks the wedding, and a hand-off now locks the wedding FOR UPDATE first, so it waited
 * at its very start rather than half-way.
 */
export async function holdOwnershipHandOff(weddingId: string, ownerEmail: string): Promise<HeldHandOff> {
  const { Client } = await import("pg");
  testPool(); // the same production refusal as every other helper here
  const client = new Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  await client.query("BEGIN");
  const { rowCount } = await client.query(
    `SELECT u.id FROM "users" u JOIN "weddings" w ON w."ownerId" = u.id
     WHERE w.id = $1 AND u.email = $2 AND u.email LIKE $3
     FOR UPDATE OF u`,
    [weddingId, ownerEmail, TEST_EMAIL_PATTERN],
  );
  if (!rowCount) {
    await client.query("ROLLBACK");
    await client.end();
    throw new Error(`testDatabase: no test wedding ${weddingId} owned by ${ownerEmail}.`);
  }
  const { rows: me } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  const pid = me[0].pid;
  let open = true;
  return {
    async waitForWaiters(count: number) {
      await waitForSessionsBlockedBy(pid, count, "the paused hand-off");
    },
    async release() {
      if (!open) return;
      open = false;
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * TS-187: tries to delete a test account straight in the database, the way a delete that skipped
 * the app's own checks would, inside a transaction that's always rolled back -- so nothing is ever
 * deleted. Returns the database's error code ("23503" when it refuses because the account still
 * owns a wedding), or null if the database would have allowed it.
 */
export async function databaseErrorDeletingAccount(email: string): Promise<string | null> {
  const { Client } = await import("pg");
  testPool(); // the same production refusal as every other helper here
  const client = new Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(`DELETE FROM "users" WHERE email = $1 AND email LIKE $2`, [email, TEST_EMAIL_PATTERN]);
    if (!rowCount) throw new Error(`testDatabase: no test account ${email}.`);
    return null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code) return code;
    throw err;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
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

/** TS-195: a delete held half-way, from outside the app -- see holdDeletion. */
export interface HeldDeletion {
  /** Resolves once `count` of the app's own database sessions are waiting (directly or in turn) on this delete. */
  waitForWaiters(count: number): Promise<void>;
  /** Saves the delete (the row is gone) and lets the waiting requests carry on. */
  commit(): Promise<void>;
  /** Undoes the delete and lets the waiting requests carry on (cleanup). */
  release(): Promise<void>;
}

/**
 * TS-195: deletes a test wedding, guest or account -- but doesn't save it yet, so requests that
 * reach the row (to lock it, or to save something that points at it) wait exactly as they would
 * behind a real delete under way. The test then saves it (commit) and checks what those requests
 * were told. Test weddings and accounts only (owner, or account, at the reserved test domain).
 * An account must own no wedding (the database refuses that delete).
 */
export async function holdDeletion(kind: "wedding" | "guest" | "account", idOrEmail: string): Promise<HeldDeletion> {
  const { Client } = await import("pg");
  testPool(); // the same production refusal as every other helper here
  const client = new Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  await client.query("BEGIN");
  const sql = {
    wedding: `DELETE FROM "weddings" w USING "users" u WHERE u.id = w."ownerId" AND w.id = $1 AND u.email LIKE $2`,
    guest: `DELETE FROM "guests" g USING "weddings" w, "users" u
            WHERE w.id = g."weddingId" AND u.id = w."ownerId" AND g.id = $1 AND u.email LIKE $2`,
    account: `DELETE FROM "users" WHERE email = $1 AND email LIKE $2`,
  }[kind];
  try {
    const { rowCount } = await client.query(sql, [idOrEmail, TEST_EMAIL_PATTERN]);
    if (!rowCount) throw new Error(`testDatabase: no test ${kind} ${idOrEmail}.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
    throw err;
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
      await waitForSessionsBlockedBy(pid, count, `the held ${kind} delete`);
    },
    async commit() {
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
  // TS-203: a rolling 24-hour count, like every daily limit now (see setCounter).
  await setCounter(`account-email:addr:day:${address}`, 86_400, limit - remaining);
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

/** TS-215: how close to a window's end a preset waits for the next window instead. */
export const WINDOW_END_MARGIN_MS = 15_000;

/**
 * TS-215: how long to wait before presetting a counter so the test's own requests land in the same
 * window -- 0 normally; within WINDOW_END_MARGIN_MS of the window's end (a daily counter at 00:00
 * UTC, 8 pm Eastern), until just after the next window starts. Pure, so it's unit-tested.
 */
export function waitBeforePresetMs(windowSeconds: number, nowMs: number): number {
  const ms = windowSeconds * 1000;
  const left = ms - (nowMs % ms);
  return left <= WINDOW_END_MARGIN_MS ? left + 250 : 0;
}

/** TS-215: waits, if needed, so a counter preset now is still the current window when the test uses it. */
async function settleIntoWindow(windowSeconds: number): Promise<void> {
  const wait = waitBeforePresetMs(windowSeconds, Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * TS-194: the app stores rate-limit windows as UTC (the column has no time zone), so the helpers
 * do too -- as text, whose "Z" the column ignores. A JavaScript date would be stored in this
 * machine's local time and land in a different window whenever it isn't UTC.
 */
function utc(date: Date): string {
  return date.toISOString();
}

/** TS-177: how many emails a test account has counted against one of its limits in the current window. */
export async function accountEmailCount(email: string, counter: AccountEmailCounter): Promise<number> {
  const { prefix, windowSeconds } = ACCOUNT_EMAIL_COUNTERS[counter];
  return readCounter(`${prefix}${await testAccountId(email)}`, windowSeconds);
}

/** TS-177: sets a test account's count against one of its email limits, so a test can reach a limit
 * without sending a hundred emails. */
export async function setAccountEmailCount(email: string, counter: AccountEmailCounter, count: number): Promise<void> {
  const { prefix, windowSeconds } = ACCOUNT_EMAIL_COUNTERS[counter];
  await setCounter(`${prefix}${await testAccountId(email)}`, windowSeconds, count);
}

/**
 * TS-203: limits of a day or more now roll over the last 24 hours (packages/db/src/queries/rate-limit.ts):
 * the app keeps them in hourly windows and counts the current hour plus the 24 before it. A test
 * that sets such a count replaces every window still counted with one in the current hour; reading
 * it adds up the same windows the app does.
 */
const HOUR_MS = 3_600_000;
const rollsDaily = (windowSeconds: number) => windowSeconds >= 86_400;

/** TS-178: sets one counter's value in its current window. Every caller below checks first that the
 * key belongs to a test address or test account. */
async function setCounter(key: string, windowSeconds: number, count: number, window: "current" | "previous" = "current"): Promise<void> {
  // TS-215: a preset made just before the window ends would be in the next window by the time the
  // test's request arrives -- wait for the new window first. TS-203: not for a rolling limit, whose
  // next hour still counts this one.
  if (!rollsDaily(windowSeconds)) await settleIntoWindow(windowSeconds);
  if (rollsDaily(windowSeconds)) {
    const hour = currentWindowStart(HOUR_MS / 1000);
    await testPool().query(`DELETE FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" >= $2::timestamp`, [
      key,
      utc(new Date(hour.getTime() - windowSeconds * 1000 - HOUR_MS)),
    ]);
    await testPool().query(`INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2::timestamp, $3)`, [
      key,
      utc(hour),
      count,
    ]);
    return;
  }
  const start = currentWindowStart(windowSeconds);
  // TS-184: "previous" is the window just before the current one, which shorter limits still count.
  if (window === "previous") start.setTime(start.getTime() - windowSeconds * 1000);
  await testPool().query(
    `INSERT INTO "rate_limit_counters" (key, "windowStart", count) VALUES ($1, $2::timestamp, $3)
     ON CONFLICT (key, "windowStart") DO UPDATE SET count = $3`,
    [key, utc(start), count],
  );
}

async function readCounter(key: string, windowSeconds: number): Promise<number> {
  if (rollsDaily(windowSeconds)) {
    // TS-203: the current hour and every hour that started in the 24 hours before it.
    const hour = currentWindowStart(HOUR_MS / 1000);
    const { rows } = await testPool().query<{ n: number }>(
      `SELECT COALESCE(SUM(count), 0)::int AS n FROM "rate_limit_counters"
        WHERE key = $1 AND "windowStart" >= $2::timestamp AND "windowStart" <= $3::timestamp`,
      [key, utc(new Date(hour.getTime() - windowSeconds * 1000)), utc(hour)],
    );
    return rows[0].n;
  }
  const { rows } = await testPool().query<{ count: number }>(
    `SELECT count FROM "rate_limit_counters" WHERE key = $1 AND "windowStart" = $2::timestamp`,
    [key, utc(currentWindowStart(windowSeconds))],
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
 * TS-194: the per-address counts kept apart from the planner-sent one above (packages/db/src/email.ts):
 * "anonymous" -- emails anyone can ask for (sign-up confirmations, "Resend link"), and
 * "unconfirmed-reset" -- password resets for an account that hasn't confirmed its address.
 */
export type OtherAddressCount = "anonymous" | "unconfirmed-reset";
const OTHER_ADDRESS_COUNT_PREFIX: Record<OtherAddressCount, string> = {
  anonymous: "email:to:anon:day:",
  "unconfirmed-reset": "email:to:reset:day:",
};

/** TS-194: sets one of a test address's other per-address counts for today. */
export async function setOtherEmailsToAddressToday(email: string, kind: OtherAddressCount, count: number): Promise<void> {
  const address = requireTestEmail(email);
  if (address.includes("+")) throw new Error("testDatabase: use a test address without a +tag.");
  await setCounter(`${OTHER_ADDRESS_COUNT_PREFIX[kind]}${address}`, 86_400, count);
}

/** TS-194: reads one of a test address's other per-address counts for today. */
export async function otherEmailsToAddressToday(email: string, kind: OtherAddressCount): Promise<number> {
  return readCounter(`${OTHER_ADDRESS_COUNT_PREFIX[kind]}${requireTestEmail(email)}`, 86_400);
}

/**
 * TS-194: sets how much of a test account's daily pool for emails nobody signed in set off (guests'
 * RSVPs, across all the weddings it owns) has been used today
 * (NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR in packages/db/src/queries/notifications.ts).
 */
export async function setOwnerNotificationEmailsToday(email: string, count: number): Promise<void> {
  await setCounter(`email:notify-owner:86400:${await testAccountId(email)}`, 86_400, count);
}

/** TS-194: how much of a test account's owner pool (see setOwnerNotificationEmailsToday) is used today. */
export async function ownerNotificationEmailsToday(email: string): Promise<number> {
  return readCounter(`email:notify-owner:86400:${await testAccountId(email)}`, 86_400);
}

/**
 * TS-194: makes a test account `days` older (moves when it was created back), so a test can reach
 * the larger daily email allowance a new account only gets after its first week.
 */
export async function ageTestAccount(email: string, days: number): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "users" SET "createdAt" = "createdAt" - make_interval(days => $3) WHERE email = $1 AND email LIKE $2`,
    [email.toLowerCase(), TEST_EMAIL_PATTERN, days],
  );
  if (!rowCount) throw new Error(`testDatabase: no test account ${email}.`);
}

export interface BrokenNotifications {
  /** Puts things back. Always call it (in a finally). */
  restore(): Promise<void>;
}

/**
 * TS-194: from now until `restore`, writing an in-app notification for this test account fails
 * the way it does when the account was deleted a moment earlier (a foreign-key error, 23503) --
 * so a test can check that a change that sets off notifications is still saved and reported as
 * saved. Only this one test account is affected (a trigger named after it, removed by restore).
 */
export async function breakNotificationsFor(email: string): Promise<BrokenNotifications> {
  const id = await testAccountId(email);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("testDatabase: unexpected account id.");
  const name = `pw_fail_notify_${id.replace(/-/g, "")}`;
  await testPool().query(
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW."recipientUserId" = '${id}' THEN
         RAISE EXCEPTION 'test: this recipient was just deleted' USING ERRCODE = 'foreign_key_violation';
       END IF;
       RETURN NEW;
     END $fn$`,
  );
  await testPool().query(`DROP TRIGGER IF EXISTS ${name} ON "notifications"`);
  await testPool().query(`CREATE TRIGGER ${name} BEFORE INSERT ON "notifications" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  return {
    async restore() {
      await testPool().query(`DROP TRIGGER IF EXISTS ${name} ON "notifications"`);
      await testPool().query(`DROP FUNCTION IF EXISTS ${name}()`);
    },
  };
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

/**
 * TS-198: gives a test guest text the app's forms refuse today but older data can hold -- an RSVP
 * note or private note with the "couldn't read this character" mark (U+FFFD), or a household name
 * with a line break (allowed before TS-190). Written as plain text, which the app reads back as it
 * reads notes saved before they were encrypted. Test weddings only.
 */
export async function plantOldGuestText(
  guestId: string,
  values: { rsvpNotes?: string; notes?: string; partyName?: string },
): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "guests" g SET
       "rsvpNotes" = COALESCE($2, g."rsvpNotes"),
       notes = COALESCE($3, g.notes),
       "partyName" = COALESCE($4, g."partyName")
     FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE g.id = $1 AND w.id = g."weddingId" AND u.email LIKE $5`,
    [guestId, values.rsvpNotes ?? null, values.notes ?? null, values.partyName ?? null, TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no guest ${guestId} on a test wedding.`);
}

/**
 * TS-221: removes a test wedding's plan version the way pruning does once a wedding has many
 * versions (wedding-caps.ts pruneOldPlanVersions) -- only one that is neither current nor approved
 * -- so a test can check what a screen does when the version it has open disappears, without making
 * fifty versions first. Test weddings only.
 */
export async function removePlanVersionAsPruningWould(planVersionId: string): Promise<void> {
  const { rowCount } = await testPool().query(
    `DELETE FROM "plan_versions" pv USING "weddings" w, "users" u
     WHERE pv.id = $1 AND w.id = pv."weddingId" AND u.id = w."ownerId" AND u.email LIKE $2
       AND NOT pv."isCurrent" AND pv.status <> 'APPROVED'`,
    [planVersionId, TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no removable test plan version ${planVersionId}.`);
}

/**
 * TS-219: the per-/48 counts an IPv6 source is also held to (apps/web/src/lib/rate-limit.ts) --
 * sign-ups per hour (SIGNUP_LIMITS.perWiderNetworkHour), wrong passwords
 * (LOGIN_LIMITS.failuresPerWiderNetwork) and RSVP-link requests (RSVP_LIMITS.perWiderNetwork) --
 * by the key and window the app uses for each.
 */
export type Ipv6NetworkCounter = "signups-hour" | "sign-in-failures" | "rsvp-requests";
const IPV6_NETWORK_COUNTERS: Record<Ipv6NetworkCounter, { prefix: string; windowSeconds: number }> = {
  "signups-hour": { prefix: "signup:addr:hour:net48:", windowSeconds: 3600 },
  "sign-in-failures": { prefix: "login:net48:", windowSeconds: 900 },
  "rsvp-requests": { prefix: "rsvp:addr:net48:", windowSeconds: 600 },
};

/** TS-219: sets one of those counts for a /48 in the documentation-only range (2001:db8::/32) tests use. */
export async function setIpv6NetworkCount(network48: string, counter: Ipv6NetworkCounter, count: number): Promise<void> {
  if (!/^2001:db8:[0-9a-f]{1,4}::\/48$/.test(network48)) throw new Error(`testDatabase: ${network48} isn't a test IPv6 /48.`);
  const { prefix, windowSeconds } = IPV6_NETWORK_COUNTERS[counter];
  await setCounter(`${prefix}${network48}`, windowSeconds, count);
}

/**
 * TS-219: how many of a test address's planner-sent emails in the last 24 hours came from senders
 * whose weddings hadn't long had the address (EMAILS_PER_RECIPIENT_FROM_UNLISTED_SENDERS in
 * packages/db/src/email.ts).
 */
export async function setUnlistedEmailsToAddressToday(email: string, count: number): Promise<void> {
  const address = requireTestEmail(email);
  if (address.includes("+")) throw new Error("testDatabase: use a test address without a +tag.");
  await setCounter(`email:to:unlisted:day:${address}`, 86_400, count);
}

export async function unlistedEmailsToAddressToday(email: string): Promise<number> {
  return readCounter(`email:to:unlisted:day:${requireTestEmail(email)}`, 86_400);
}

/**
 * TS-219: makes a test guest look added, and last changed, `hours` ago. Test weddings only.
 * TS-232: their email address too ("emailChangedAt", what "listed for over a day" goes by).
 */
export async function backdateGuest(guestId: string, hours: number): Promise<void> {
  const { rowCount } = await testPool().query(
    `UPDATE "guests" g SET "createdAt" = now() - make_interval(hours => $2), "updatedAt" = now() - make_interval(hours => $2),
            "emailChangedAt" = now() - make_interval(hours => $2)
     FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE g.id = $1 AND w.id = g."weddingId" AND u.email LIKE $3`,
    [guestId, hours, TEST_EMAIL_PATTERN],
  );
  if (!rowCount) throw new Error(`testDatabase: no guest ${guestId} on a test wedding.`);
}
