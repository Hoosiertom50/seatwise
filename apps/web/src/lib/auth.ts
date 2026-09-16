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

// TS-62 SPIKE (DO NOT MERGE): candidate fix, replacing the login/signup routes' previous
// `secure: process.env.NODE_ENV === "production"`. That conflated "this is a production *build*"
// with "this app is being served over HTTPS right now" -- `next build && next start` (exactly what
// this repo's own CI e2e jobs do, including this one) sets NODE_ENV=production even when the app is
// served over plain HTTP, so the auth cookie ended up marked `Secure` in CI too. A `Secure` cookie
// set over plain HTTP is spec-invalid and a browser may refuse to store it at all -- Chromium and
// Firefox both carve out a "localhost is trustworthy" exception that let this slide silently, but
// real-world reports (and TS-62's own run #21, which showed 401s starting immediately after a
// successful login, and WeddingDetailPage.tsx's own 401 handler redirecting to /login mid-test --
// matching TS-60's original "tab-navigation timeout/detach" pattern exactly) point to WebKit not
// extending the same exception, silently dropping the cookie instead.
//
// Derived from APP_URL instead -- the same env var and fallback the rsvp-link and invites routes
// already use for this app's own canonical URL (apps/web/src/app/api/v1/weddings/[weddingId]/
// guests/[guestId]/rsvp-link/route.ts, .../invites/route.ts) -- so this actually reflects the
// scheme the app is being served over rather than guessing from the build mode. Unset in this
// repo's CI (defaults to the same "http://localhost:3000" those two routes fall back to), so this
// resolves to `false` there; a real deployment sets APP_URL to its own https:// origin already (for
// those two routes to generate correct links), so this resolves to `true` there with no new config.
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
