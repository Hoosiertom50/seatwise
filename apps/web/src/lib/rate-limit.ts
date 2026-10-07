import { NextResponse } from "next/server";
import { accountDailyEmailKey, accountDailyEmailLimit, hitRateLimit, peekRateLimit, undoRateLimitHit } from "@seatwise/db";
import { emailLimitReason, tooManyAttemptsMessage, type EmailLimitReason } from "./limit-messages";
import { clientNetworks } from "./client-address";

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

// TS-178: new weddings per account per day (creating or copying one). Every wedding comes with
// its own allowance for emails nobody signed in sets off (guests' RSVPs, see
// NOTIFICATION_EMAILS_PER_WEDDING_WITHOUT_ACTOR), so without a cap one account could multiply that
// allowance. A planner setting up several weddings in one sitting stays well under 10.
export const WEDDING_CREATE_LIMITS = {
  perAccountDay: { limit: 10, windowSeconds: 86_400 },
};
export const weddingCreateKey = (userId: string) => `weddings:create:day:${userId}`;

// TS-164: confirming an email address -- link uses per address (guessing isn't feasible; this only
// stops abuse), and "Resend link" per account, so it can't be used to flood an inbox.
export const EMAIL_VERIFICATION_LIMITS = {
  confirmsPerAddress: { limit: 30, windowSeconds: 900 },
  resendsPerAccount: { limit: 3, windowSeconds: 900 },
  // TS-168: daily ceilings, so "Resend link" can't be used to flood one inbox or spend the day's
  // email allowance.
  // TS-171: so the sign-up email plus every resend stays within the per-address daily cap -- a
  // resend is refused plainly rather than "sent" into a cap. TS-194: that cap is now 3 for emails
  // anyone can ask for (ANONYMOUS_EMAILS_PER_RECIPIENT_PER_DAY in packages/db/src/email.ts), so 2:
  // the sign-up email and two resends. Per network address, resends now count in
  // ACCOUNT_EMAIL_LIMITS below (10 a day, with sign-ups and resets) instead of a separate 20.
  resendsPerAccountDay: { limit: 2, windowSeconds: 86_400 },
};

// TS-171: emails about an account -- sign-up confirmations, "Resend link" and password resets --
// asked for from one network address in a day, all counted together. Each has its own limits too,
// but separately they added up to hundreds a day from one source.
// TS-194 (Tom's decision): one count for every email someone who isn't signed in (or an account
// that hasn't confirmed its address) can make Seatwise send -- sign-up confirmations, "Resend
// link", and password resets for confirmed and unconfirmed accounts alike -- 10 a day per network
// address. Counted only when an email really goes out, and given back otherwise. Past it a sign-up
// still makes the account (without its email); "Resend link" works again tomorrow. This replaces
// the separate 20-a-day counts for sign-up confirmations and resends.
// TS-203: "a day" is now the last 24 hours, rolling (see packages/db/src/queries/rate-limit.ts) --
// at midnight UTC it used to start again, so twice the limit fitted in a couple of hours. And an
// IPv6 source is also counted by its /48 (perWiderNetworkDay): a free tunnel hands out a /48, which
// is 65,536 /64s, each of which had its own 10. Roomier than one /64's, since a /48 can be a whole
// office or campus.
export const ACCOUNT_EMAIL_LIMITS = {
  perAddressDay: { limit: 10, windowSeconds: 86_400 },
  perWiderNetworkDay: { limit: 30, windowSeconds: 86_400 },
};
export const accountEmailAddressKey = (address: string) => `account-email:addr:day:${address}`;
export const accountEmailWiderNetworkKey = (network: string) => `account-email:net48:day:${network}`;

/**
 * TS-203: every per-network count one account email (sign-up confirmation, "Resend link", password
 * reset) goes on: the address (an IPv4 address, or an IPv6 /64), and for IPv6 its /48 too.
 */
export function accountEmailCounters(req: { headers: Headers }): { key: string; limit: number; windowSeconds: number }[] {
  const { address, wider } = clientNetworks(req);
  return [
    { key: accountEmailAddressKey(address), ...ACCOUNT_EMAIL_LIMITS.perAddressDay },
    ...(wider ? [{ key: accountEmailWiderNetworkKey(wider), ...ACCOUNT_EMAIL_LIMITS.perWiderNetworkDay }] : []),
  ];
}

// TS-142: "forgot password" -- requests per address and per email (the per-email cap is what keeps
// one inbox from being flooded), and attempts to use a link per address. Links are 64 random hex
// characters, so guessing one isn't feasible; that limit only stops abuse, hence generous.
export const PASSWORD_RESET_LIMITS = {
  requestsPerAddress: { limit: 50, windowSeconds: 900 },
  requestsPerEmail: { limit: 3, windowSeconds: 900 },
  // TS-168: daily ceilings -- reset emails share a reserved part of the daily email allowance.
  requestsPerAddressDay: { limit: 100, windowSeconds: 86_400 },
  requestsPerEmailDay: { limit: 6, windowSeconds: 86_400 },
  // TS-186: while the account is locked by the sign-in limits, the same daily count may go this
  // high instead -- so someone who locked the owner out can't also leave them no reset, yet one
  // inbox still can't be flooded without end.
  requestsPerEmailDayWhileLocked: { limit: 12, windowSeconds: 86_400 },
  resetsPerAddress: { limit: 100, windowSeconds: 900 },
};

// TS-186: wrong passwords when deleting the account (the person is already signed in), per
// account. Counted with the sign-in counter for this account from this network address -- but not
// the account-wide one, which anyone can fill from many addresses (it would let a stranger stop
// someone deleting their own account).
export const ACCOUNT_DELETE_LIMITS = {
  failuresPerAccount: { limit: 10, windowSeconds: 3600 },
};
export function accountDeleteFailureLimits(userId: string, email: string, address: string) {
  const account = email.trim().toLowerCase();
  return [
    { key: `login:account-addr:${account}:${address}`, ...LOGIN_LIMITS.failuresPerAccountAndAddress },
    { key: `account-delete:failures:${userId}`, ...ACCOUNT_DELETE_LIMITS.failuresPerAccount },
  ];
}

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

const accountSignInFailuresKey = (account: string) => `login:account:${account}`;

/**
 * TS-178: whether the sign-in limits currently lock this account out from everywhere (too many
 * wrong passwords for it, from any number of addresses). Only looks; counts nothing.
 */
export async function accountSignInLocked(email: string): Promise<boolean> {
  const { limit, windowSeconds } = LOGIN_LIMITS.failuresPerAccount;
  return !(await peekRateLimit(accountSignInFailuresKey(email.trim().toLowerCase()), limit, windowSeconds)).allowed;
}

// TS-171: the failure counters one password attempt counts against. Keyed by the email as typed
// (lowercased) whether or not an account exists, so the limits can't reveal which are registered.
export function signInFailureLimits(email: string, address: string, { perAddress = true }: { perAddress?: boolean } = {}) {
  const account = email.trim().toLowerCase();
  return [
    { key: `login:account-addr:${account}:${address}`, ...LOGIN_LIMITS.failuresPerAccountAndAddress },
    { key: accountSignInFailuresKey(account), ...LOGIN_LIMITS.failuresPerAccount },
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
    // TS-186: each count is taken back from the window it was made in.
    giveBack: async () => {
      await Promise.all(limits.map(({ key, windowSeconds }, i) => undoRateLimitHit(key, windowSeconds, results[i].windowStart)));
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
  message: LimitMessage
): Promise<NextResponse | null> {
  const result = await peekRateLimit(key, limit, windowSeconds);
  if (result.allowed) return null;
  return NextResponse.json(
    { error: typeof message === "function" ? message(result.retryAfterSeconds) : message },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

// TS-73: moved to ./client-address so it can be unit-tested without a database; re-exported here
// so every existing caller keeps importing it from this module.
export { clientAddress, clientNetworks } from "./client-address";

// TS-177: the refusal messages live in ./limit-messages (unit-testable without a database).
export {
  ACCOUNT_DAILY_EMAIL_LIMIT_REACHED,
  NEW_ACCOUNT_DAILY_EMAIL_LIMIT_REACHED,
  ACCOUNT_SHARE_OF_EMAIL_REACHED,
  RECIPIENT_LIMITED_MESSAGE,
  emailSendRefusedMessage,
  RSVP_LINK_TOO_MANY_SUBMITS,
  TOO_MANY_INVITES,
  TOO_MANY_WEDDINGS_TODAY,
  tooManyAttemptsMessage,
  type EmailLimitReason,
} from "./limit-messages";

// Counts this request against `key`; returns a ready 429 response when it's over the limit, or
// null to carry on. TS-177: the message follows the window (a daily limit says "tomorrow", not "a
// few minutes"), and `message` replaces it where the generic text wouldn't be accurate (a limit
// counted per link from anywhere, say, isn't "from here").
// TS-186: a refused request is given back, as sign-in does -- so tries made while refused don't
// keep the limit going for longer.
// TS-203: `message` can be worked out from the wait (seconds until another try fits), so a daily
// limit can say how long it really is.
type LimitMessage = string | ((retryAfterSeconds: number) => string);

export async function rateLimitOr429(
  key: string,
  limits: { limit: number; windowSeconds: number },
  message?: LimitMessage
): Promise<NextResponse | null> {
  return (await countOr429(key, limits, message)).limited;
}

/**
 * TS-186: rateLimitOr429, plus `giveBack` to take this request's count back later (from exactly
 * the window it was counted in) -- for a request that turns out to send nothing.
 */
export async function countOr429(
  key: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number },
  message?: LimitMessage
): Promise<{ limited: NextResponse | null; giveBack: () => Promise<void> }> {
  const result = await hitRateLimit(key, limit, windowSeconds);
  let counted = true;
  const giveBack = async () => {
    if (!counted) return;
    counted = false;
    await undoRateLimitHit(key, windowSeconds, result.windowStart);
  };
  if (result.allowed) return { limited: null, giveBack };
  await giveBack();
  return {
    limited: NextResponse.json(
      {
        error:
          typeof message === "function"
            ? message(result.retryAfterSeconds)
            : (message ?? tooManyAttemptsMessage(windowSeconds, result.retryAfterSeconds)),
      },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
    ),
    giveBack,
  };
}

// TS-156: how many emails one signed-in person can make Seatwise send to other people. Seatwise
// sends from one Gmail account; without a ceiling, one account could spam strangers through it
// and get it suspended, which would stop every email -- password resets included. Real planning
// stays well under these: a wedding has a few collaborators and ~150 guests, emailed over weeks.
//
// TS-171: on top of these, every kind of email an account sends counts toward one daily allowance
// (ACCOUNT_EMAILS_PER_DAY, 100). RSVP emails used to have their own 500 a day -- more than the
// whole site's everyday ceiling -- so that allowance is now the only daily limit on them.
// TS-194: 20 a day for an account in its first week (see accountDailyEmailLimit).
export const EMAIL_SEND_LIMITS: Record<"invites" | "rsvpEmails", readonly { limit: number; windowSeconds: number }[]> = {
  invites: [
    { limit: 20, windowSeconds: 3600 },
    { limit: 60, windowSeconds: 86_400 },
  ],
  rsvpEmails: [{ limit: 100, windowSeconds: 3600 }],
};

// TS-177: refused, with which limit it was (see emailSendRefusedMessage for the words).
// TS-186: allowed comes with `release`, which gives the counts back from the windows they were made in.
// TS-203: refused comes with how long until it would fit (the longest of the refusing windows), so
// the message can say it.
export type EmailSendReservation =
  | { allowed: true; release: () => Promise<void> }
  | { allowed: false; reason: EmailLimitReason; retryAfterSeconds: number };

async function emailSendCounters(kind: keyof typeof EMAIL_SEND_LIMITS, userId: string) {
  const { limit, windowSeconds, newAccount } = await accountDailyEmailLimit(userId);
  return [
    ...EMAIL_SEND_LIMITS[kind].map(({ limit, windowSeconds }) => ({
      key: `email:${kind}:${windowSeconds}:${userId}`,
      limit,
      windowSeconds,
      accountDaily: false,
      newAccount: false,
    })),
    { key: accountDailyEmailKey(userId), limit, windowSeconds, accountDaily: true, newAccount },
  ];
}

/**
 * TS-156: counts one email of `kind` sent by `userId` against every window; refused once any
 * window is over its limit (the email should then not be sent). TS-171: and against the account's
 * daily allowance for all kinds of email together.
 *
 * TS-177: a refused email uses nothing up, so one full window can't quietly drain the others.
 * TS-186: that now includes the windows that refused it, so refused tries don't keep a full
 * window full for longer.
 */
export async function reserveEmailSend(kind: keyof typeof EMAIL_SEND_LIMITS, userId: string): Promise<EmailSendReservation> {
  const counters = await emailSendCounters(kind, userId);
  const results = await Promise.all(counters.map(({ key, limit, windowSeconds }) => hitRateLimit(key, limit, windowSeconds)));
  let counted = true;
  const release = async () => {
    if (!counted) return;
    counted = false;
    await Promise.all(counters.map((c, i) => undoRateLimitHit(c.key, c.windowSeconds, results[i].windowStart)));
  };
  if (results.every((r) => r.allowed)) return { allowed: true, release };
  await release();
  return {
    allowed: false,
    reason: emailLimitReason(counters.filter((_, i) => !results[i].allowed)),
    retryAfterSeconds: Math.max(1, ...results.filter((r) => !r.allowed).map((r) => r.retryAfterSeconds)),
  };
}

/**
 * TS-168: gives back one email counted by reserveEmailSend, when nothing was sent after all.
 * TS-186: pass the reservation, so the counts come back from exactly the windows they were made
 * in; without it, the current windows are used (as before).
 */
export async function releaseEmailSend(
  kind: keyof typeof EMAIL_SEND_LIMITS,
  userId: string,
  reservation?: EmailSendReservation
): Promise<void> {
  if (reservation?.allowed) return reservation.release();
  // Only the windows' keys are needed here, so the allowance's size doesn't matter.
  const counters = EMAIL_SEND_LIMITS[kind].map(({ windowSeconds }) => ({ key: `email:${kind}:${windowSeconds}:${userId}`, windowSeconds }));
  counters.push({ key: accountDailyEmailKey(userId), windowSeconds: 86_400 });
  await Promise.all(counters.map(({ key, windowSeconds }) => undoRateLimitHit(key, windowSeconds)));
}

// TS-171: once a guest has been emailed their RSVP link, asking for the link again (to copy it)
// doesn't email them again for an hour -- so the button can't be used to flood one inbox. A
// brand-new link ("New link", "Reset all guest and vendor links", or a corrected address) is still
// emailed straight away.
// TS-186: a real hour from the last email (see claimCooldown) -- clicks in between don't add to it.
export const RSVP_RESEND_COOLDOWN_SECONDS = 3600;

/**
 * TS-186: the key the hour is kept under: the guest, the address, and the link itself (by the
 * start of its stored hash, never the link) -- so once the links are reset, the new one can be
 * emailed straight away.
 */
export function rsvpLinkCooldownKey(guestId: string, email: string, linkHash: string): string {
  return `email:rsvp-link:${guestId}:${email.trim().toLowerCase()}:${linkHash.slice(0, 16)}`;
}
