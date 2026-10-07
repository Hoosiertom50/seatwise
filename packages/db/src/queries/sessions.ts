import { pool } from "../pool";

// TS-204 (Tom's decision): "Log out" ends the session on this device only. Each session token
// carries its own id (claim "sid", apps/web/src/lib/auth.ts); logging out records it here until the
// token would have expired anyway, and a token whose id is here is refused (getAuthSession in
// apps/web/src/lib/session.ts). "Log out on all devices" and a password reset still end every
// session at once by moving users."sessionVersion" on (TS-155).

/**
 * Ends one session. Kept until `expiresAt` (the token's own expiry -- after that it's refused
 * anyway), and rows already past their expiry are cleared out on the way.
 */
export async function revokeSession(sessionId: string, userId: string, expiresAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO "revoked_sessions" (id, "userId", "expiresAt") VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, userId, expiresAt]
  );
  // Cleared a few at a time, so no one log out does a big delete.
  await pool.query(
    `DELETE FROM "revoked_sessions" WHERE id IN (
       SELECT id FROM "revoked_sessions" WHERE "expiresAt" < now() LIMIT 500
     )`
  );
}

/** True when this session was ended with "Log out". */
export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM "revoked_sessions" WHERE id = $1`, [sessionId]);
  return rows.length > 0;
}
