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
import { resolveIsProduction } from "./productionGuard";
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
