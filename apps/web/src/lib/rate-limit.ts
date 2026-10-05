import { NextResponse } from "next/server";
import { ACCOUNT_EMAILS_PER_DAY, accountDailyEmailKey, hitRateLimit, peekRateLimit, undoRateLimitHit } from "@seatwise/db";

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

// TS-163: invite links need no sign-in to look up either -- same per-address ceiling.
export const INVITE_LINK_LIMITS = {
  perAddress: { limit: 100, windowSeconds: 600 },
};

// TS-163: new accounts from one network address. Each account comes with its own email allowance
// (EMAIL_SEND_LIMITS), so unlimited sign-ups would get round it. Roomy enough for a team signing
// up together from one office connection.
export const SIGNUP_LIMITS = {
  perAddressHour: { limit: 30, windowSeconds: 3600 },
  perAddressDay: { limit: 100, windowSeconds: 86_400 },
};

// TS-164: confirming an email address -- link uses per address (guessing isn't feasible; this only
// stops abuse), and "Resend link" per account, so it can't be used to flood an inbox.
export const EMAIL_VERIFICATION_LIMITS = {
  confirmsPerAddress: { limit: 30, windowSeconds: 900 },
  resendsPerAccount: { limit: 3, windowSeconds: 900 },
  // TS-168: daily ceilings, so "Resend link" can't be used to flood one inbox or spend the day's
  // email allowance.
  // TS-171: 4, so the sign-up email plus every resend stays within the per-address daily email cap
  // (EMAILS_PER_RECIPIENT_PER_DAY in packages/db/src/email.ts) -- a resend is refused plainly
  // rather than "sent" into a cap.
  resendsPerAccountDay: { limit: 4, windowSeconds: 86_400 },
  resendsPerAddressDay: { limit: 20, windowSeconds: 86_400 },
};

// TS-171: emails about an account -- sign-up confirmations, "Resend link" and password resets --
// asked for from one network address in a day, all counted together. Each has its own limits too,
// but separately they added up to hundreds a day from one source. Roomy enough for a team signing
// up together from one office connection.
export const ACCOUNT_EMAIL_LIMITS = {
  // As many as the address may sign up in a day (SIGNUP_LIMITS), so a shared office network isn't
  // cut short; resets keep their own reserved allowance either way.
  perAddressDay: { limit: 100, windowSeconds: 86_400 },
};
export const accountEmailAddressKey = (address: string) => `account-email:addr:day:${address}`;

// TS-142: "forgot password" -- requests per address and per email (the per-email cap is what keeps
// one inbox from being flooded), and attempts to use a link per address. Links are 64 random hex
// characters, so guessing one isn't feasible; that limit only stops abuse, hence generous.
export const PASSWORD_RESET_LIMITS = {
  requestsPerAddress: { limit: 50, windowSeconds: 900 },
  requestsPerEmail: { limit: 3, windowSeconds: 900 },
  // TS-168: daily ceilings -- reset emails share a reserved part of the daily email allowance.
  requestsPerAddressDay: { limit: 100, windowSeconds: 86_400 },
  requestsPerEmailDay: { limit: 6, windowSeconds: 86_400 },
  resetsPerAddress: { limit: 100, windowSeconds: 900 },
};

// TS-113: failed sign-in attempts (a correct password never counts), so real use can never lock
// anyone out. Per account, so no one can keep guessing one person's password; per address, so one
// source can't spray guesses across many accounts. Once over, even the right password waits out
// the window -- otherwise the limit would tell an attacker which guess was correct.
//
// TS-171: the tight per-account limit is now per account *from one address*, so someone else's
// wrong guesses can't keep the owner locked out of their own account. A much higher limit for the
// account from everywhere together still stops guessing spread over many addresses.
export const LOGIN_LIMITS = {
  failuresPerAccountAndAddress: { limit: 10, windowSeconds: 900 },
  failuresPerAccount: { limit: 100, windowSeconds: 900 },
  failuresPerAddress: { limit: 30, windowSeconds: 900 },
};

// TS-171: the failure counters one password attempt counts against. Keyed by the email as typed
// (lowercased) whether or not an account exists, so the limits can't reveal which are registered.
export function signInFailureLimits(email: string, address: string, { perAddress = true }: { perAddress?: boolean } = {}) {
  const account = email.trim().toLowerCase();
  return [
    { key: `login:account-addr:${account}:${address}`, ...LOGIN_LIMITS.failuresPerAccountAndAddress },
    { key: `login:account:${account}`, ...LOGIN_LIMITS.failuresPerAccount },
    ...(perAddress ? [{ key: `login:addr:${address}`, ...LOGIN_LIMITS.failuresPerAddress }] : []),
  ];
}

/**
 * TS-155 / TS-171: counts one password attempt against every limit *before* the password is
 * checked (so many attempts sent at once can't all slip under). `giveBack` takes the count back --
 * for a correct password (only failures count) or an attempt refused without being tried (TS-157).
 */
export async function countSignInAttempt(
  limits: { key: string; limit: number; windowSeconds: number }[]
): Promise<{ allowed: boolean; retryAfterSeconds: number; giveBack: () => Promise<void> }> {
  const results = await Promise.all(limits.map(({ key, limit, windowSeconds }) => hitRateLimit(key, limit, windowSeconds)));
  return {
    allowed: results.every((r) => r.allowed),
    retryAfterSeconds: Math.max(0, ...results.filter((r) => !r.allowed).map((r) => r.retryAfterSeconds)),
    giveBack: async () => {
      await Promise.all(limits.map(({ key, windowSeconds }) => undoRateLimitHit(key, windowSeconds)));
    },
  };
}

// TS-154 (Tom's decision #6): the lock stays, with a way to get in right away.
export const TOO_MANY_SIGN_INS =
  "Too many sign-in attempts. Please wait a few minutes and try again, or use \"Forgot password?\" to reset your password and sign in now.";

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
//
// TS-171: on top of these, every kind of email an account sends counts toward one daily allowance
// (ACCOUNT_EMAILS_PER_DAY, 100). RSVP emails used to have their own 500 a day -- more than the
// whole site's everyday ceiling -- so that allowance is now the only daily limit on them.
export const EMAIL_SEND_LIMITS: Record<"invites" | "rsvpEmails", readonly { limit: number; windowSeconds: number }[]> = {
  invites: [
    { limit: 20, windowSeconds: 3600 },
    { limit: 60, windowSeconds: 86_400 },
  ],
  rsvpEmails: [{ limit: 100, windowSeconds: 3600 }],
};

export const TOO_MANY_INVITES =
  "You've sent a lot of invites in a short time. Please wait a while before sending more.";

/**
 * TS-156: counts one email of `kind` sent by `userId` against every window; false once any window
 * is over its limit (the email should then not be sent). TS-171: and against the account's daily
 * allowance for all kinds of email together.
 */
export async function reserveEmailSend(kind: keyof typeof EMAIL_SEND_LIMITS, userId: string): Promise<boolean> {
  const results = await Promise.all([
    ...EMAIL_SEND_LIMITS[kind].map(({ limit, windowSeconds }) =>
      hitRateLimit(`email:${kind}:${windowSeconds}:${userId}`, limit, windowSeconds)
    ),
    hitRateLimit(accountDailyEmailKey(userId), ACCOUNT_EMAILS_PER_DAY.limit, ACCOUNT_EMAILS_PER_DAY.windowSeconds),
  ]);
  return results.every((r) => r.allowed);
}

/** TS-168: gives back one email counted by reserveEmailSend, when nothing was sent after all. */
export async function releaseEmailSend(kind: keyof typeof EMAIL_SEND_LIMITS, userId: string): Promise<void> {
  await Promise.all([
    ...EMAIL_SEND_LIMITS[kind].map(({ windowSeconds }) => undoRateLimitHit(`email:${kind}:${windowSeconds}:${userId}`, windowSeconds)),
    undoRateLimitHit(accountDailyEmailKey(userId), ACCOUNT_EMAILS_PER_DAY.windowSeconds),
  ]);
}

// TS-171: once a guest has been emailed their RSVP link, asking for the link again (to copy it)
// doesn't email them again until the next hour -- so the button can't be used to flood one inbox.
// A brand-new link ("New link", or a corrected address) is still emailed straight away.
export const RSVP_RESEND_COOLDOWN_SECONDS = 3600;
