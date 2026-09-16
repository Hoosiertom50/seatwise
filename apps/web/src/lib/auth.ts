import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";

const JWT_SECRET = process.env.JWT_SECRET;

function getSecretKey() {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is not set");
  }
  return new TextEncoder().encode(JWT_SECRET);
}

// Web (browser) clients get the token via an httpOnly cookie so front-end JS never has to
// touch it. A future native (iOS/Android) client hits the exact same /api/v1/auth endpoints
// but reads `token` from the JSON body instead and sends it back as
// `Authorization: Bearer <token>` — see getAuthUser() below, which accepts either.
export const AUTH_COOKIE_NAME = "seatwise_token";

// TS-62: the auth cookie's `secure` flag used to be `process.env.NODE_ENV === "production"`. That
// conflates "this is a production *build*" with "this app is being served over HTTPS right now" --
// `next build && next start` (what every CI e2e job here does, and what a real production deploy
// does too) sets NODE_ENV=production even when the app is served over plain HTTP, so the cookie
// ended up marked `Secure` in CI, where the app runs at plain http://localhost:3000. A `Secure`
// cookie set over plain HTTP is spec-invalid; Chromium and Firefox both silently tolerate this on
// localhost, but WebKit does not extend the same exception and drops the cookie -- every request
// after that 401s. That was the real root cause behind TS-62's WebKit CI failures (TS-60's original
// spike, and this cookie's own behavior confirmed by direct code inspection plus a live CI
// reproduction showing 401s immediately after a successful login): not a hydration/click-timing
// issue (a settle-wait candidate fix was tried and disproved first -- see the TS-62 spike branch's
// own commit history for that ruled-out iteration).
//
// Derived from APP_URL instead -- the same env var and fallback the rsvp-link and invites routes
// already use for this app's own canonical URL (apps/web/src/app/api/v1/weddings/[weddingId]/
// guests/[guestId]/rsvp-link/route.ts, .../invites/route.ts) -- so this reflects the scheme the app
// is actually being served over rather than guessing from the build mode. Unset in CI (defaults to
// the same "http://localhost:3000" those two routes fall back to), so this resolves to `false`
// there; a real deployment already sets APP_URL to its own https:// origin for those two routes, so
// this resolves to `true` there with no new config needed.
export function isSecureCookieContext(): boolean {
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  return appUrl.startsWith("https://");
}

export interface TokenPayload {
  sub: string;
  email: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecretKey());
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
