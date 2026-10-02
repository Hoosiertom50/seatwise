// TS-116: the few facts an e2e test can't reach through the app itself, read (or, for one case,
// set) directly in the local database.
//
// - An invite's token. The app deliberately never returns it over the API -- it exists only in the
//   invite email, and there's no inbox a test can read (email is a console stand-in locally and in
//   CI). Without it the accept flow, the one real way anyone joins a wedding, can't be driven.
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

/** The token in an invite's emailed accept link (`/invites/<token>`). */
export async function inviteToken(inviteId: string): Promise<string> {
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

/** TS-143: a guest's current RSVP token (null if no link has been made yet), for guests on weddings
 * owned by a test account only. */
export async function guestRsvpToken(guestId: string): Promise<string | null> {
  const { rows } = await testPool().query<{ token: string | null }>(
    `SELECT g."rsvpToken" AS token FROM "guests" g
     JOIN "weddings" w ON w.id = g."weddingId" JOIN "users" u ON u.id = w."ownerId"
     WHERE g.id = $1 AND u.email LIKE $2`,
    [guestId, TEST_EMAIL_PATTERN],
  );
  if (!rows[0]) throw new Error(`testDatabase: no guest ${guestId} on a test wedding.`);
  return rows[0].token;
}
