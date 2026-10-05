import { randomBytes, randomUUID } from "crypto";
import { pool } from "../pool";
import { hashResetToken } from "./password-reset";

// TS-164: "confirm your email" links (Tom's decision, 2026-10-05: everyone confirms at sign-up).
// Same design as password-reset links (TS-142): 32 random bytes, only the SHA-256 hash stored,
// single use. A link works for 48 hours; asking for a new one leaves older ones working (any of
// them confirms the same address).

export const EMAIL_VERIFICATION_TTL_HOURS = 48;

/** Issues a new confirmation token for the user and returns it (to be emailed, never stored). */
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO "email_verification_tokens" (id, "userId", "tokenHash", "expiresAt")
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [randomUUID(), userId, hashResetToken(token), EMAIL_VERIFICATION_TTL_HOURS]
  );
  return token;
}

/**
 * Confirms the address the token was sent to. Returns the user's id, or null if the token is
 * unknown, used or expired. Atomic, and every outstanding link for the account is used up.
 */
export async function verifyEmailWithToken(token: string): Promise<{ userId: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ userId: string }>(
      `SELECT "userId" FROM "email_verification_tokens"
       WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > now()
       FOR UPDATE`,
      [hashResetToken(token)]
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE "email_verification_tokens" SET "usedAt" = now() WHERE "userId" = $1 AND "usedAt" IS NULL`,
      [row.userId]
    );
    await client.query(
      `UPDATE "users" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()), "updatedAt" = now() WHERE id = $1`,
      [row.userId]
    );
    await client.query("COMMIT");
    return { userId: row.userId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
