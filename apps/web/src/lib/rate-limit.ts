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
