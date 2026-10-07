import { pool } from "../pool";

// TS-204 (Tom's decision): "Log out" ends the session on this device only. Each session token
// carries its own id (claim "sid", apps/web/src/lib/auth.ts); logging out records it here until no
// token of that session can still be valid (renewed copies included -- see revokedSessionKeepUntil
// in apps/web/src/lib/session-renewal.ts), and a token whose id is here is refused (getAuthSession in
// apps/web/src/lib/session.ts). "Log out on all devices" and a password reset still end every
// session at once by moving users."sessionVersion" on (TS-155).

/**
 * Ends one session. Kept until `expiresAt` (the latest any token of the session could expire --
 * after that it's refused anyway), and rows already past their expiry are cleared out on the way.
 */
export async function revokeSession(sessionId: string, userId: string, expiresAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO "revoked_sessions" (id, "userId", "expiresAt") VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET "expiresAt" = GREATEST("revoked_sessions"."expiresAt", EXCLUDED."expiresAt")`,
    [sessionId, userId, expiresAt]
  );
  // Cleared a few at a time, so no one log out does a big delete.
  // TS-204 (Copilot review): only housekeeping -- the session is already ended above, so a failure
  // here is logged and never turns a log out that worked into an error.
  try {
    await pool.query(
      `DELETE FROM "revoked_sessions" WHERE id IN (
         SELECT id FROM "revoked_sessions" WHERE "expiresAt" < now() LIMIT 500
       )`
    );
  } catch (err) {
    console.error("Logged out, but clearing old ended sessions failed:", err);
  }
}

/** True when this session was ended with "Log out". */
export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM "revoked_sessions" WHERE id = $1`, [sessionId]);
  return rows.length > 0;
}
