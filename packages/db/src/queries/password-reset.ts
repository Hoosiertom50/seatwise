import { createHash, randomBytes, randomUUID } from "crypto";
import { pool, beginTransaction } from "../pool";
import { claimCooldown, releaseCooldown } from "./rate-limit";

// TS-142: "forgot password" links. The emailed token is 32 random bytes; only its SHA-256 hash is
// stored. A link works once, for one hour, and asking for a new one cancels any older unused ones.

export const PASSWORD_RESET_TTL_MINUTES = 60;

// TS-200: a plain SHA-256 is right here, and CodeQL's "insufficient password hash" warning on this
// line doesn't apply. What's hashed is never a password someone chose: it's a reset (or email
// confirmation, see email-verification.ts) link's token, 32 bytes from randomBytes (64 hex
// characters, 256 bits). A slow hash like bcrypt only helps when
// the input is guessable; nobody can guess 256 random bits, and a fast hash lets the link be looked
// up by its hash in one indexed query. Passwords themselves are hashed with bcrypt (TS-163).
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// TS-187: how long a used or expired link is kept before it's cleared away (they're never read
// again; keeping a month helps when looking into "my link didn't work").
export const OLD_ACCOUNT_LINK_DAYS = 30;

// TS-187: opportunistic cleanup, ~1 new link in 100 (like the rate-limit counters): links that
// expired over a month ago are deleted. Runs in the background; a failure is harmless.
export function pruneOldPasswordResetTokens(): void {
  if (Math.random() >= 0.01) return;
  pool
    .query(`DELETE FROM "password_reset_tokens" WHERE "expiresAt" < now() - make_interval(days => $1)`, [OLD_ACCOUNT_LINK_DAYS])
    .catch(() => {});
}

/**
 * Issues a new reset token for the user and returns it. TS-153: older links stay valid until the
 * new one has actually been emailed -- call retireOlderResetTokens then -- so a failed send never
 * leaves the person with no working link at all.
 */
export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await client.query(
      `INSERT INTO "password_reset_tokens" (id, "userId", "tokenHash", "expiresAt")
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [randomUUID(), userId, hashResetToken(token), PASSWORD_RESET_TTL_MINUTES]
    );
    await client.query("COMMIT");
    pruneOldPasswordResetTokens();
    return token;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Whether a token would still work (unused and unexpired), without using it. */
export async function isPasswordResetTokenUsable(token: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM "password_reset_tokens" WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > now()`,
    [hashResetToken(token)]
  );
  return rows.length > 0;
}

/**
 * TS-171: a link whose email didn't go out is cancelled, so it never counts as "already sent"
 * (see hasUsablePasswordResetToken) -- the person can ask again straight away.
 * TS-219: deleted outright (it never reached anyone), so every link left from the last day is one
 * that was emailed -- what lastPasswordResetAt goes by.
 */
export async function discardPasswordResetToken(token: string): Promise<void> {
  await pool.query(`DELETE FROM "password_reset_tokens" WHERE "tokenHash" = $1 AND "usedAt" IS NULL`, [hashResetToken(token)]);
}

/**
 * TS-253: the fallback when an unsent link couldn't be deleted -- it's marked used instead, so it
 * neither works nor counts as "already sent" (see hasUsablePasswordResetToken).
 */
export async function markPasswordResetTokenUsed(token: string): Promise<void> {
  await pool.query(`UPDATE "password_reset_tokens" SET "usedAt" = now() WHERE "tokenHash" = $1 AND "usedAt" IS NULL`, [hashResetToken(token)]);
}

// TS-219: once the day's reset counts for an address are full, the newest reset still goes out if
// none has gone to the account for this long. Someone who signed up with another person's address
// could otherwise ask for 3 resets (an hour apart) and use up the count meant for the address's
// owner, who then couldn't get the reset that lets them take the account back. The owner now waits
// at most this long; the inbox still gets no more than one reset every few hours past the count.
export const NEWEST_RESET_AFTER_SECONDS = 3 * 3600;

/** TS-219: when the newest reset link from the last 24 hours was made (null if none). */
export async function lastPasswordResetAt(userId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ last: Date | null }>(
    `SELECT max("createdAt") AS last FROM "password_reset_tokens" WHERE "userId" = $1 AND "createdAt" > now() - interval '24 hours'`,
    [userId]
  );
  return rows[0]?.last ?? null;
}

/** TS-219: whether the newest reset may go out past full daily counts (see NEWEST_RESET_AFTER_SECONDS). Pure. */
export function newestResetMayGo(lastResetAt: Date | null, nowMs: number = Date.now()): boolean {
  return lastResetAt === null || nowMs - lastResetAt.getTime() >= NEWEST_RESET_AFTER_SECONDS * 1000;
}

/**
 * TS-232: how long until the newest reset may go out past full daily counts (see
 * NEWEST_RESET_AFTER_SECONDS), in whole seconds -- 0 when it already may. Pure.
 */
export function newestResetWaitSeconds(lastResetAt: Date | null, nowMs: number = Date.now()): number {
  if (newestResetMayGo(lastResetAt, nowMs)) return 0;
  return Math.max(1, Math.ceil((lastResetAt!.getTime() + NEWEST_RESET_AFTER_SECONDS * 1000 - nowMs) / 1000));
}

/** TS-228: the key the newest-reset slot (see claimNewestResetSlot) is kept under. */
export const newestResetSlotKey = (userId: string) => `pw-reset:newest:${userId}`;

/**
 * TS-228: claims, atomically, the one reset that may go out past full daily counts after a quiet
 * few hours. Checking the quiet spell on its own let several requests sent at the same moment all
 * pass it (up to 3 resets instead of 1); only one of them can claim this. `release` gives it back
 * when no email went out after all. Lasts NEWEST_RESET_AFTER_SECONDS, like the quiet spell itself.
 */
export async function claimNewestResetSlot(
  userId: string
): Promise<{ claimed: boolean; retryAfterSeconds: number; release: () => Promise<void> }> {
  const key = newestResetSlotKey(userId);
  const claim = await claimCooldown(key, NEWEST_RESET_AFTER_SECONDS);
  if (!claim.allowed || !claim.claimedAt) return { claimed: false, retryAfterSeconds: claim.retryAfterSeconds, release: async () => {} };
  const claimedAt = claim.claimedAt;
  return { claimed: true, retryAfterSeconds: 0, release: () => releaseCooldown(key, claimedAt) };
}

/**
 * TS-171: whether the person already has a reset link that still works (unused, and issued within
 * the last hour, which is how long a link lasts).
 */
export async function hasUsablePasswordResetToken(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM "password_reset_tokens" WHERE "userId" = $1 AND "usedAt" IS NULL AND "expiresAt" > now() LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

/**
 * Uses the token to set a new password. Returns the user, or null if the token is unknown, used or
 * expired. Atomic: two simultaneous uses of the same link can't both succeed.
 */
export async function resetPasswordWithToken(
  token: string,
  newPasswordHash: string
): Promise<{ id: string; email: string; sessionVersion: number } | null> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows } = await client.query<{ id: string; userId: string }>(
      `SELECT id, "userId" FROM "password_reset_tokens"
       WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > now()
       FOR UPDATE`,
      [hashResetToken(token)]
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    await client.query(`UPDATE "password_reset_tokens" SET "usedAt" = now() WHERE "userId" = $1 AND "usedAt" IS NULL`, [
      row.userId,
    ]);
    // TS-155: a new password also ends every existing session.
    const { rows: users } = await client.query<{ id: string; email: string; sessionVersion: number }>(
      // TS-164: using a link emailed to the address also proves the person owns it.
      `UPDATE "users" SET "passwordHash" = $1, "sessionVersion" = "sessionVersion" + 1,
         "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()), "updatedAt" = now()
       WHERE id = $2 RETURNING id, email, "sessionVersion"`,
      [newPasswordHash, row.userId]
    );
    await client.query("COMMIT");
    return users[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * TS-153: once a new link has been emailed, every older unused link for that person stops working.
 * TS-186: only links made *before* this one -- two requests at the same moment used to retire each
 * other's link, leaving the person with two emails and no link that worked. Now the newer one
 * always survives.
 */
export async function retireOlderResetTokens(userId: string, keepToken: string): Promise<void> {
  await pool.query(
    `UPDATE "password_reset_tokens" SET "usedAt" = now()
     WHERE "userId" = $1 AND "usedAt" IS NULL AND "tokenHash" <> $2
       AND "createdAt" < (SELECT "createdAt" FROM "password_reset_tokens" WHERE "tokenHash" = $2)`,
    [userId, hashResetToken(keepToken)]
  );
}
