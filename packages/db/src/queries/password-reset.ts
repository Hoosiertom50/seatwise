import { createHash, randomBytes, randomUUID } from "crypto";
import { pool } from "../pool";

// TS-142: "forgot password" links. The emailed token is 32 random bytes; only its SHA-256 hash is
// stored. A link works once, for one hour, and asking for a new one cancels any older unused ones.

export const PASSWORD_RESET_TTL_MINUTES = 60;

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "password_reset_tokens" (id, "userId", "tokenHash", "expiresAt")
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [randomUUID(), userId, hashResetToken(token), PASSWORD_RESET_TTL_MINUTES]
    );
    await client.query("COMMIT");
    return token;
  } catch (err) {
    await client.query("ROLLBACK");
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
 * Uses the token to set a new password. Returns the user, or null if the token is unknown, used or
 * expired. Atomic: two simultaneous uses of the same link can't both succeed.
 */
export async function resetPasswordWithToken(
  token: string,
  newPasswordHash: string
): Promise<{ id: string; email: string; sessionVersion: number } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; userId: string }>(
      `SELECT id, "userId" FROM "password_reset_tokens"
       WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > now()
       FOR UPDATE`,
      [hashResetToken(token)]
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(`UPDATE "password_reset_tokens" SET "usedAt" = now() WHERE "userId" = $1 AND "usedAt" IS NULL`, [
      row.userId,
    ]);
    // TS-155: a new password also ends every existing session.
    const { rows: users } = await client.query<{ id: string; email: string; sessionVersion: number }>(
      `UPDATE "users" SET "passwordHash" = $1, "sessionVersion" = "sessionVersion" + 1, "updatedAt" = now()
       WHERE id = $2 RETURNING id, email, "sessionVersion"`,
      [newPasswordHash, row.userId]
    );
    await client.query("COMMIT");
    return users[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** TS-153: once a new link has been emailed, every older unused link for that person stops working. */
export async function retireOlderResetTokens(userId: string, keepToken: string): Promise<void> {
  await pool.query(
    `UPDATE "password_reset_tokens" SET "usedAt" = now()
     WHERE "userId" = $1 AND "usedAt" IS NULL AND "tokenHash" <> $2`,
    [userId, hashResetToken(keepToken)]
  );
}
