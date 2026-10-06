import { SignJWT, jwtVerify } from "jose";
import type { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { appBaseUrl } from "./app-url";

const JWT_SECRET = process.env.JWT_SECRET;

let warnedShortSecret = false;

function getSecretKey() {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is not set");
  }
  // TS-172: a short secret could be guessed offline from any session token. It's reported rather
  // than refused, so a deployment with a shorter secret keeps working while it's replaced.
  if (process.env.NODE_ENV === "production" && JWT_SECRET.length < 32 && !warnedShortSecret) {
    warnedShortSecret = true;
    console.error("[auth] JWT_SECRET is shorter than 32 characters -- replace it with a long random value.");
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
// Derived from the app's own address instead (TS-178: appBaseUrl in ./app-url, the same one every
// emailed link uses), so this reflects the scheme the app is actually being served over rather than
// guessing from the build mode. In CI that's http://localhost:3000, so this resolves to `false`
// there; a real deployment sets APP_URL to its own https:// origin, so this resolves to `true`.
let warnedNoAppUrl = false;
export function isSecureCookieContext(): boolean {
  try {
    return appBaseUrl().startsWith("https://");
  } catch (err) {
    // TS-149 / TS-178: a production build without a proper APP_URL -- say so loudly in the logs,
    // and keep the cookie Secure (the safe choice for a real site) rather than failing every sign-in.
    if (!warnedNoAppUrl) {
      warnedNoAppUrl = true;
      console.error(`${err instanceof Error ? err.message : String(err)} Session cookies stay Secure; emailed links won't work.`);
    }
    return true;
  }
}

export interface TokenPayload {
  sub: string;
  email: string;
  // TS-94: when the user actually signed in (seconds since epoch), carried forward unchanged every
  // time the token is renewed, so renewal can have an absolute limit. Absent on tokens issued
  // before TS-94 -- treated as their own issue time.
  authTime?: number;
  // TS-155: the account's session version when this token was issued (claim "sv"). A token whose
  // version is older than the account's current one has been ended (password reset, log out).
  // Absent on tokens issued before TS-155 -- treated as 0.
  sessionVersion?: number;
}

export interface VerifiedToken extends TokenPayload {
  issuedAt: number;
  authTime: number;
  sessionVersion: number;
}

// TS-94: a token is valid for 30 days from when it was *issued*, and an active session keeps being
// re-issued (see proxy.ts / session-renewal.ts) -- so in practice a session only ends after 30 days
// with no activity at all, or once RENEWAL_LIMIT_SECONDS has passed since the user last really
// signed in, whichever comes first.
export const AUTH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signToken(payload: TokenPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: payload.email, authTime: payload.authTime ?? now, sv: payload.sessionVersion ?? 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + AUTH_TOKEN_TTL_SECONDS)
    .sign(getSecretKey());
}

export async function verifyToken(token: string): Promise<VerifiedToken | null> {
  try {
    // TS-172: only the algorithm Seatwise signs with is accepted.
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    const issuedAt = typeof payload.iat === "number" ? payload.iat : 0;
    const authTime = typeof payload.authTime === "number" ? payload.authTime : issuedAt;
    const sessionVersion = typeof payload.sv === "number" ? payload.sv : 0;
    return { sub: payload.sub, email: payload.email, issuedAt, authTime, sessionVersion };
  } catch {
    return null;
  }
}

// One definition of the session cookie, shared by login, signup and TS-94's renewal (proxy.ts) so
// the three can never drift apart on lifetime or flags.
export function setAuthCookie(response: NextResponse, token: string): void {
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    // TS-62: see isSecureCookieContext's own doc comment above.
    secure: isSecureCookieContext(),
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_TOKEN_TTL_SECONDS,
  });
}

// TS-172: the session token goes back in a sign-in response's body only to a client that keeps it
// itself (the mobile app, which says so with this header). A web page gets it only as the
// httpOnly cookie -- a copy in the body is something a script injected into the page could read.
export const BEARER_CLIENT_HEADER = "x-seatwise-client";
export function wantsBearerToken(req: { headers: Headers }): boolean {
  return req.headers.get(BEARER_CLIENT_HEADER) === "mobile";
}
