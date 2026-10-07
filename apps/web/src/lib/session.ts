import { NextRequest } from "next/server";
import { findUserById, isSessionRevoked, type UserRow } from "@seatwise/db";
import { verifyToken, AUTH_COOKIE_NAME, type VerifiedToken } from "./auth";

/**
 * TS-204: why a request has no signed-in account --
 * NO_SESSION: no token, or one that isn't valid (wrong signature, expired);
 * SESSION_ENDED: a valid token whose session was ended (this device's "Log out", "Log out on all
 *   devices", a password reset);
 * ACCOUNT_GONE: a valid token for an account that no longer exists (it was deleted).
 * Only /auth/me says which, so a retried "Delete my account" can tell "deleted" from "signed out".
 */
export type NoSessionReason = "NO_SESSION" | "SESSION_ENDED" | "ACCOUNT_GONE";

export type AuthSession =
  | { user: UserRow; token: VerifiedToken }
  | { user: null; reason: NoSessionReason };

function tokenFrom(req: NextRequest): string | undefined {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice("Bearer ".length);
  return req.cookies.get(AUTH_COOKIE_NAME)?.value;
}

export async function getAuthSession(req: NextRequest): Promise<AuthSession> {
  const token = tokenFrom(req);
  if (!token) return { user: null, reason: "NO_SESSION" };
  const payload = await verifyToken(token);
  if (!payload) return { user: null, reason: "NO_SESSION" };

  const [user, revoked] = await Promise.all([
    findUserById(payload.sub),
    payload.sessionId ? isSessionRevoked(payload.sessionId) : Promise.resolve(false),
  ]);
  if (!user) return { user: null, reason: "ACCOUNT_GONE" };
  // TS-155: a session ended by a password reset or "Log out on all devices" stays ended, even
  // though its token is still correctly signed and unexpired. TS-204: and so does one ended on its
  // own device ("Log out").
  if (user.sessionVersion !== payload.sessionVersion || revoked) return { user: null, reason: "SESSION_ENDED" };
  return { user, token: payload };
}

export async function getAuthUser(req: NextRequest): Promise<UserRow | null> {
  return (await getAuthSession(req)).user;
}
