import { NextResponse } from "next/server";
import { hitRateLimit, peekRateLimit } from "@seatwise/db";

// TS-98: limits for the public, unauthenticated guest RSVP link -- the one part of the API anyone
// on the internet can call without signing in. Generous enough that no real guest (or a household
// sharing one wifi connection) ever notices; tight enough to stop scripted flooding.
export const RSVP_LIMITS = {
  // Every RSVP request (page loads and submits) from one network address.
  perAddress: { limit: 100, windowSeconds: 600 },
  // Submissions against one guest's link, from anywhere -- a guest changing their mind a few
  // times is normal; hundreds of submits is not.
  submitsPerLink: { limit: 10, windowSeconds: 600 },
};

// TS-114: a vendor's read-only link needs no sign-in either -- same per-address ceiling as RSVP.
export const VENDOR_LINK_LIMITS = {
  perAddress: { limit: 100, windowSeconds: 600 },
};

// TS-142: "forgot password" -- requests per address and per email (the per-email cap is what keeps
// one inbox from being flooded), and attempts to use a link per address. Links are 64 random hex
// characters, so guessing one isn't feasible; that limit only stops abuse, hence generous.
export const PASSWORD_RESET_LIMITS = {
  requestsPerAddress: { limit: 50, windowSeconds: 900 },
  requestsPerEmail: { limit: 3, windowSeconds: 900 },
  resetsPerAddress: { limit: 100, windowSeconds: 900 },
};

// TS-113: failed sign-in attempts (a correct password never counts), so real use can never lock
// anyone out. Per account, so no one can keep guessing one person's password; per address, so one
// source can't spray guesses across many accounts. Once over, even the right password waits out
// the window -- otherwise the limit would tell an attacker which guess was correct.
export const LOGIN_LIMITS = {
  failuresPerAccount: { limit: 10, windowSeconds: 900 },
  failuresPerAddress: { limit: 30, windowSeconds: 900 },
};

export const TOO_MANY_SIGN_INS = "Too many sign-in attempts. Please wait a few minutes and try again.";

// TS-113: 429 if `key` has already reached its limit in this window, without counting anything.
export async function over429(
  key: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number },
  message: string
): Promise<NextResponse | null> {
  const result = await peekRateLimit(key, limit, windowSeconds);
  if (result.allowed) return null;
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

// TS-73: moved to ./client-address so it can be unit-tested without a database; re-exported here
// so every existing caller keeps importing it from this module.
export { clientAddress } from "./client-address";

// Counts this request against `key`; returns a ready 429 response when it's over the limit, or
// null to carry on.
export async function rateLimitOr429(
  key: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number }
): Promise<NextResponse | null> {
  const result = await hitRateLimit(key, limit, windowSeconds);
  if (result.allowed) return null;
  return NextResponse.json(
    { error: "Too many attempts from here in a short time. Please wait a few minutes and try again." },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

// TS-156: how many emails one signed-in person can make Seatwise send to other people. Seatwise
// sends from one Gmail account; without a ceiling, one account could spam strangers through it
// and get it suspended, which would stop every email -- password resets included. Real planning
// stays well under these: a wedding has a few collaborators and ~150 guests, emailed over weeks.
export const EMAIL_SEND_LIMITS = {
  invites: [
    { limit: 20, windowSeconds: 3600 },
    { limit: 60, windowSeconds: 86_400 },
  ],
  rsvpEmails: [
    { limit: 150, windowSeconds: 3600 },
    { limit: 500, windowSeconds: 86_400 },
  ],
} as const;

export const TOO_MANY_INVITES =
  "You've sent a lot of invites in a short time. Please wait a while before sending more.";

/**
 * TS-156: counts one email of `kind` sent by `userId` against every window; false once any window
 * is over its limit (the email should then not be sent).
 */
export async function reserveEmailSend(kind: keyof typeof EMAIL_SEND_LIMITS, userId: string): Promise<boolean> {
  const results = await Promise.all(
    EMAIL_SEND_LIMITS[kind].map(({ limit, windowSeconds }) =>
      hitRateLimit(`email:${kind}:${windowSeconds}:${userId}`, limit, windowSeconds)
    )
  );
  return results.every((r) => r.allowed);
}
