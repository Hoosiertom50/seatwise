import nodemailer from "nodemailer";
import { Resend } from "resend";
import { pool } from "./pool";
import { runningOnNetlify } from "@seatwise/shared";
import { hitRateLimitCount, hitRollingCount, ROLLING_BUCKET_SECONDS, undoRateLimitHit } from "./queries/rate-limit";

// TS-132: how Seatwise sends email, chosen from the environment:
//
// - SMTP (Tom's decision, 2026-10-01: a dedicated Gmail account, seatwise.notifications@gmail.com,
//   sending with a Gmail app password) -- when SMTP_USER and SMTP_PASSWORD are set. Host and port
//   default to Gmail's (smtp.gmail.com, 465/TLS).
// - Resend -- when RESEND_API_KEY is set instead (kept for later, once there's a domain).
// - "log" -- prints the email instead of sending it. The default outside production (local dev),
//   and what CI asks for explicitly with EMAIL_TRANSPORT=log, so no test ever sends real email.
// - none -- production with nothing configured. Nothing is sent, and callers are told so, so the
//   planner sees the link to share by hand instead of a false "sent".
//
// Sending never throws: a failed email must never block the action that triggered it.

// TS-171: "recipient-limited" -- this address has already had its share of Seatwise email today.
// TS-203: "account-limited" -- the account it's charged to has had its share of Seatwise's whole
// allowance (ACCOUNT_SHARE_OF_EVERYDAY) for the last 24 hours. "uncertain" -- the mail server
// stopped answering after the message may already have been handed over, so it may well have
// gone out: it stays counted, and a link in it is kept working (see isAmbiguousSendError).
export type EmailResult =
  | "sent"
  | "logged"
  | "not-configured"
  | "failed"
  | "limited"
  | "recipient-limited"
  | "account-limited"
  | "uncertain";

type EmailEnv = Record<string, string | undefined>;

export type EmailTransportConfig =
  | { kind: "smtp"; host: string; port: number; secure: boolean; user: string; pass: string; from: string }
  | { kind: "resend"; apiKey: string; from: string }
  | { kind: "log" }
  | { kind: "none" };

export function resolveEmailTransport(env: EmailEnv = process.env): EmailTransportConfig {
  // TS-172: an explicit "log" always wins -- even if Gmail or Resend credentials are also present
  // (say, in a developer's .env while the test suite runs), nothing is really sent.
  if (env.EMAIL_TRANSPORT === "log") return { kind: "log" };
  if (env.SMTP_USER && env.SMTP_PASSWORD) {
    const port = Number(env.SMTP_PORT || 465);
    return {
      kind: "smtp",
      host: env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
      // Gmail only sends as the account that signed in, so that's the default sender.
      from: env.EMAIL_FROM || `Seatwise <${env.SMTP_USER}>`,
    };
  }
  if (env.RESEND_API_KEY) {
    return {
      kind: "resend",
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM || env.RESEND_FROM_EMAIL || "Seatwise <notifications@seatwise.app>",
    };
  }
  if (env.EMAIL_TRANSPORT === "log" || env.NODE_ENV !== "production") return { kind: "log" };
  return { kind: "none" };
}

/** Whether the person was (or, in local dev and CI, would have been) emailed. */
export function emailDelivered(result: EmailResult): boolean {
  return result === "sent" || result === "logged";
}

/**
 * TS-203: whether the email may have gone out -- delivered, or "uncertain" (the server went quiet
 * after it may have been handed over). Such an email keeps its counts, and anything it carries
 * (a reset link) is kept working, so the person isn't sent a link that no longer works.
 */
export function emailMayHaveGone(result: EmailResult): boolean {
  return emailDelivered(result) || result === "uncertain";
}

/**
 * TS-203: a send that failed in a way that leaves it unclear whether the message went out. The
 * SMTP client reports a quiet server (no answer within socketTimeout) or a dropped connection the
 * same way whatever stage it was at -- including after the whole message was sent, waiting for
 * the server's "accepted". Gmail may have sent those. A connection that never opened ("Connection
 * timeout", "Greeting never received", refused, DNS) or a server's clear refusal (a reply code) is
 * a plain failure.
 */
export function isAmbiguousSendError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; responseCode?: number } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.responseCode === "number") return false;
  const message = String(e.message ?? "");
  if (e.code === "ETIMEDOUT") return !/connection timeout|greeting never received/i.test(message);
  if (e.code === "ECONNECTION") return /closed unexpectedly/i.test(message);
  return false;
}

type Sender = (config: EmailTransportConfig, message: { to: string; subject: string; text: string }) => Promise<void>;

let smtpTransport: ReturnType<typeof nodemailer.createTransport> | undefined;
let resendClient: Resend | undefined;

const realSender: Sender = async (config, message) => {
  if (config.kind === "smtp") {
    // TS-203: one shared, pooled transport for the whole server -- connections (and the Gmail
    // sign-in on each) are kept and reused, instead of a new sign-in for every email. Several
    // notifications set off by one change go out over a few connections at once.
    smtpTransport ??= nodemailer.createTransport({
      pool: true,
      maxConnections: 3,
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      // A slow mail server must not hold up the planner's request for long.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    await smtpTransport.sendMail({ from: config.from, ...message });
  } else if (config.kind === "resend") {
    resendClient ??= new Resend(config.apiKey);
    const { error } = await resendClient.emails.send({ from: config.from, ...message });
    if (error) throw new Error(error.message);
  }
};

let sender: Sender = realSender;

// TS-163: a ceiling on how many emails Seatwise sends, whoever triggers them. Everything goes out
// through one Gmail account; hitting Gmail's own limit gets the account throttled or suspended,
// which would stop password resets too. Per-person limits (TS-156) can be got round with many
// accounts; this can't. Only real sends count -- the "log" transport used locally and in CI never
// touches this.
//
// TS-171: email-confirmation links come out of the everyday allowance, not the resets' budget.
// TS-186: password resets for confirmed accounts have a budget of their own, so everyday emails
// can never use it up -- and resets can never use up the everyday allowance that invites and RSVP
// emails need. Total real sends: everyday + resets.
//
// TS-194 (Tom's decision, 2026-10-06: keep Gmail, simpler and stricter limits): Gmail counts about 500
// recipients over any 24 hours -- a rolling window, not a calendar day. These counts now roll too
// (the current hour plus the 24 before it, see hitRollingCount), and the total is about 300 --
// everyday 240 + resets 60 -- well clear of Gmail's limit. EMAIL_DAILY_LIMIT can still change the
// everyday number, but never so far that everyday + resets goes over 450.
export const EVERYDAY_EMAILS_PER_24_HOURS = 240;
const DAILY_WINDOW_SECONDS = 86_400;
export const RESET_EMAILS_PER_24_HOURS = 60;
export const MAX_EMAILS_PER_24_HOURS = 450;

// TS-178: an email-address confirmation (anyone can sign up with any address) may only use this
// share of the everyday allowance, so a burst of sign-ups can't leave nothing for invites and RSVP
// emails. Past it the account is still made; "Resend link" works again in a few hours.
export const CONFIRMATION_SHARE_OF_EVERYDAY = 0.25;
// TS-186: a reset for an account that hasn't confirmed its address is an everyday email (anyone
// can sign up with any address), held to this smaller share of the everyday allowance -- so resets
// asked for on such accounts can't crowd out invites and RSVP emails either.
export const UNCONFIRMED_RESET_SHARE_OF_EVERYDAY = 0.1;
// TS-203: no one account -- with every kind of email it sends, together -- may use more than this
// share of the everyday allowance in any 24 hours. (TS-219: emails its weddings' guests set off no
// longer count here -- see sendEmail's `forGuestsOf`.) Each
// of its own limits was fine alone, but together they let one account (or three new ones) use up
// all of it, and then nobody's invites, RSVP links or confirmations went out.
export const ACCOUNT_SHARE_OF_EVERYDAY = 0.25;
// TS-203: this much of the everyday allowance is kept for invites and RSVP links (emails a planner
// sends to a guest or a new collaborator) -- notifications, sign-up confirmations and unconfirmed
// accounts' resets stop short of it, so they can never leave planners unable to reach their guests.
export const PLANNER_EMAIL_FLOOR_SHARE_OF_EVERYDAY = 0.2;
// TS-203: this many of the resets' own budget are kept for accounts locked out by wrong passwords
// (the person most needing a reset) -- other resets stop short of them.
export const LOCKED_OUT_RESETS_RESERVED = 15;
// TS-219: every account in its first week (NEW_ACCOUNT_DAYS), together, may use at most this share
// of the everyday allowance -- including the emails their weddings' guests set off. Each new
// account alone was held to 20, but a dozen of them (cheap to make) could still use all 240 between
// them, and then nobody's invites or RSVP links went out.
// TS-240: only invites and RSVP links (emails a first-week planner sends to someone outside the
// wedding) count here now -- not notifications to the wedding's own members, nor emails guests'
// answers set off. Those have pools of their own (see notifications.ts), and counting them let one
// busy new planner fill the whole share (20 + 20 + 20 = 60) and stop every other new planner's
// invites and RSVP links for a day. The share is larger too: 96 of 240, room for nearly 5 new
// planners' full 20 links each.
export const NEW_ACCOUNTS_SHARE_OF_EVERYDAY = 0.4;
// TS-232: emails guests' answers set off (RSVP notifications, see sendEmail's `forGuestsOf`), from
// every wedding together, may use at most this share of the everyday allowance (48 of 240). They
// aren't charged to anyone's own share, and each owner had a pool of 60 for them -- so two week-old
// accounts could use all 240 between them (2 x (60 + 60)).
// TS-241: and one owner's pool (60) was larger than this whole share, so a single account could use
// it all up and stop every other wedding's RSVP emails for a day. Each owner's pool is now 12 (5 in
// the account's first week -- see NOTIFICATION_EMAILS_PER_OWNER_WITHOUT_ACTOR), so filling the 48
// takes at least 4 established owners, or 10 first-week ones.
export const GUEST_ANSWERS_SHARE_OF_EVERYDAY = 0.2;

export function dailyEmailLimits(env: EmailEnv = process.env): {
  everyday: number;
  resets: number;
  confirmations: number;
  unconfirmedResets: number;
  accountShare: number;
  plannerFloor: number;
  lockedOutResets: number;
  newAccounts: number;
  guestAnswers: number;
} {
  const configured = Number(env.EMAIL_DAILY_LIMIT);
  const asked = Number.isInteger(configured) && configured > 0 ? configured : EVERYDAY_EMAILS_PER_24_HOURS;
  // TS-194: clamped, so everyday + resets can never go over MAX_EMAILS_PER_24_HOURS.
  const everyday = Math.min(asked, MAX_EMAILS_PER_24_HOURS - RESET_EMAILS_PER_24_HOURS);
  return {
    everyday,
    resets: RESET_EMAILS_PER_24_HOURS,
    confirmations: Math.max(1, Math.floor(everyday * CONFIRMATION_SHARE_OF_EVERYDAY)),
    unconfirmedResets: Math.max(1, Math.floor(everyday * UNCONFIRMED_RESET_SHARE_OF_EVERYDAY)),
    accountShare: Math.max(1, Math.floor(everyday * ACCOUNT_SHARE_OF_EVERYDAY)),
    plannerFloor: Math.floor(everyday * PLANNER_EMAIL_FLOOR_SHARE_OF_EVERYDAY),
    lockedOutResets: Math.min(LOCKED_OUT_RESETS_RESERVED, RESET_EMAILS_PER_24_HOURS - 1),
    newAccounts: Math.max(1, Math.floor(everyday * NEW_ACCOUNTS_SHARE_OF_EVERYDAY)),
    guestAnswers: Math.max(1, Math.floor(everyday * GUEST_ANSWERS_SHARE_OF_EVERYDAY)),
  };
}

// TS-186: a hit returns the window it was counted in, and undo takes exactly that one back.
type Counted = { count: number; windowStart: Date };
type DailyCounter = { hit: () => Promise<Counted>; undo: (windowStart: Date) => Promise<void> };
// TS-194: the site-wide counts roll over the last 24 hours (new keys, so the old calendar-day rows
// are never mistaken for an hour's count).
const rollingCounterFor = (key: string): DailyCounter => ({
  hit: () => hitRollingCount(key),
  undo: (windowStart) => undoRateLimitHit(key, ROLLING_BUCKET_SECONDS, windowStart),
});
const realDailyCounter = rollingCounterFor("email:global:24h:everyday");
let dailyCounter: DailyCounter = realDailyCounter;

// TS-178: the confirmations' own share, counted the same way (real sends only).
const realConfirmationCounter = rollingCounterFor("email:global:24h:confirmations");
let confirmationCounter: DailyCounter = realConfirmationCounter;

/** Tests only: replace the counter for the confirmations' share (pass nothing to restore it). */
export function setConfirmationEmailCounterForTests(fake?: DailyCounter): void {
  confirmationCounter = fake ?? realConfirmationCounter;
}

// TS-186: confirmed accounts' resets (their own budget), and unconfirmed accounts' resets (their
// share of the everyday allowance) -- real sends only, like the rest.
const realResetCounter = rollingCounterFor("email:global:24h:resets");
let resetCounter: DailyCounter = realResetCounter;
const realUnconfirmedResetCounter = rollingCounterFor("email:global:24h:unconfirmed-resets");
let unconfirmedResetCounter: DailyCounter = realUnconfirmedResetCounter;

/** Tests only: replace the counters for password resets (pass nothing to restore them). */
export function setResetEmailCountersForTests(fakes?: { confirmed: DailyCounter; unconfirmed: DailyCounter }): void {
  resetCounter = fakes?.confirmed ?? realResetCounter;
  unconfirmedResetCounter = fakes?.unconfirmed ?? realUnconfirmedResetCounter;
}

// TS-203: each account's share of the everyday allowance (ACCOUNT_SHARE_OF_EVERYDAY) -- real sends
// only, like the rest of the site-wide counts.
export const accountShareKey = (accountId: string) => `email:global:24h:account:${accountId}`;
const realAccountShareCounter = (accountId: string) => rollingCounterFor(accountShareKey(accountId));
let accountShareCounter: (accountId: string) => DailyCounter = realAccountShareCounter;

/** Tests only: replace the per-account share counter (pass nothing to restore it). */
export function setAccountShareCounterForTests(fake?: (accountId: string) => DailyCounter): void {
  accountShareCounter = fake ?? realAccountShareCounter;
}

// TS-219: the first-week accounts' combined share (NEW_ACCOUNTS_SHARE_OF_EVERYDAY) -- real sends only.
const realNewAccountsCounter = rollingCounterFor("email:global:24h:new-accounts");
let newAccountsCounter: DailyCounter = realNewAccountsCounter;
/** Tests only: replace the first-week accounts' combined counter (pass nothing to restore it). */
export function setNewAccountsCounterForTests(fake?: DailyCounter): void {
  newAccountsCounter = fake ?? realNewAccountsCounter;
}
// TS-232: guests' answers' site-wide share (GUEST_ANSWERS_SHARE_OF_EVERYDAY) -- real sends only.
const realGuestAnswersCounter = rollingCounterFor("email:global:24h:guest-answers");
let guestAnswersCounter: DailyCounter = realGuestAnswersCounter;
/** Tests only: replace the guests' answers' site-wide counter (pass nothing to restore it). */
export function setGuestAnswersCounterForTests(fake?: DailyCounter): void {
  guestAnswersCounter = fake ?? realGuestAnswersCounter;
}
// TS-219: whether an account is in its first week (see accountDailyEmailLimit).
const realAccountIsNew = async (accountId: string) => (await accountDailyEmailLimit(accountId)).newAccount;
let accountIsNew: (accountId: string) => Promise<boolean> = realAccountIsNew;
/** Tests only: replace the "is this account in its first week?" lookup (pass nothing to restore it). */
export function setAccountIsNewForTests(fake?: (accountId: string) => Promise<boolean>): void {
  accountIsNew = fake ?? realAccountIsNew;
}

// TS-171: at most a few emails a day to any one address, however they're asked for and by however
// many accounts -- so nobody can use Seatwise to fill a stranger's inbox. Confirmed accounts'
// password resets have their own per-address limits (see the forgot-password route), and
// notifications only go to confirmed members of a wedding, so neither counts here.
// TS-213: those members can now each turn notification emails off for themselves (the "Email me
// about this wedding" switch on the Collaborators tab), and every notification email says why it
// came and how to stop it. Unlike the site-wide ceiling this also counts with the "log" transport,
// so it behaves the same locally and in CI.
// TS-203: "a day" is the last 24 hours, rolling (see hitRateLimitCount), and one account may use
// only EMAILS_PER_RECIPIENT_PER_SENDER of an address's planner-sent emails -- so a stranger's
// account can't use them all up and leave the address's real planner unable to reach them.
//
// TS-194: split by who can ask for the email. Emails a planner sends (invites, RSVP links) have
// their own count, so a stranger asking for confirmation emails can't use up a guest's invites.
// Emails anyone can ask for (sign-up confirmations and "Resend link") have a small count of their
// own. A reset for an account that hasn't confirmed its address has a third count -- so whoever
// signed up with someone else's address can't use "Resend link" to stop the address's real owner
// getting the reset that lets them take the account back (the reset limits per email still hold).
export const EMAILS_PER_RECIPIENT_PER_DAY = 5;
export const ANONYMOUS_EMAILS_PER_RECIPIENT_PER_DAY = 3;
export const UNCONFIRMED_RESETS_PER_RECIPIENT_PER_DAY = 3;
export const EMAILS_PER_RECIPIENT_PER_SENDER = 3;
// TS-219: and senders whose weddings haven't long had the address (see senderListsRecipient) may
// use only this many of the 5 between them -- so two accounts (3 + 2) can no longer fill a
// stranger's 5 and leave the planner whose guest list really has them no way to email them. The
// rest (1) is kept for planners whose wedding has had the address for over a day.
export const EMAILS_PER_RECIPIENT_FROM_UNLISTED_SENDERS = 4;
export const LISTED_RECIPIENT_MIN_AGE_SECONDS = 86_400;
export type RecipientCount = "planner" | "anonymous" | "unconfirmed-reset";
const RECIPIENT_LIMITS: Record<RecipientCount, number> = {
  planner: EMAILS_PER_RECIPIENT_PER_DAY,
  anonymous: ANONYMOUS_EMAILS_PER_RECIPIENT_PER_DAY,
  "unconfirmed-reset": UNCONFIRMED_RESETS_PER_RECIPIENT_PER_DAY,
};

/**
 * TS-178: the mailbox an address really reaches, for the per-address count only (the email still
 * goes to the address as given). Upper/lower case, a "+tag" and -- for Gmail -- dots all reach the
 * same inbox, so they used to count as different addresses.
 */
export function recipientCountAddress(to: string): string {
  const lowered = to.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at <= 0) return lowered;
  let local = lowered.slice(0, at);
  let domain = lowered.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
/** TS-194: the key each per-address count is kept under (the planner one is unchanged). */
export function recipientCountKey(kind: RecipientCount, to: string): string {
  const address = recipientCountAddress(to);
  if (kind === "anonymous") return `email:to:anon:day:${address}`;
  if (kind === "unconfirmed-reset") return `email:to:reset:day:${address}`;
  return `email:to:day:${address}`;
}
/** TS-219: the key for what senders who haven't long listed the address have sent it, together. */
export function unlistedSendersRecipientCountKey(to: string): string {
  return `email:to:unlisted:day:${recipientCountAddress(to)}`;
}
/** TS-203: the key for one account's share of an address's planner-sent emails. */
export function senderRecipientCountKey(accountId: string, to: string): string {
  return `email:to:sender:day:${accountId}:${recipientCountAddress(to)}`;
}

/** TS-178: an address as the logs show it -- "v***@gmail.com" -- so logs don't collect people's addresses. */
export function maskEmailAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${trimmed[0]}***${trimmed.slice(at)}`;
}

type RecipientCounter = {
  hit: (to: string, kind: RecipientCount) => Promise<Counted>;
  undo: (to: string, kind: RecipientCount, windowStart: Date) => Promise<void>;
};
const realRecipientCounter: RecipientCounter = {
  hit: (to, kind) => hitRateLimitCount(recipientCountKey(kind, to), DAILY_WINDOW_SECONDS),
  undo: (to, kind, windowStart) => undoRateLimitHit(recipientCountKey(kind, to), DAILY_WINDOW_SECONDS, windowStart),
};
let recipientCounter: RecipientCounter = realRecipientCounter;

/** Tests only: replace the per-recipient email counter (pass nothing to restore it). */
export function setRecipientEmailCounterForTests(fake?: RecipientCounter): void {
  recipientCounter = fake ?? realRecipientCounter;
}

// TS-203: one account's share of an address's planner-sent emails (counted in every mode, like the
// per-address count).
const realSenderRecipientCounter = (accountId: string, to: string): DailyCounter => {
  const key = senderRecipientCountKey(accountId, to);
  return {
    hit: () => hitRateLimitCount(key, DAILY_WINDOW_SECONDS),
    undo: (windowStart) => undoRateLimitHit(key, DAILY_WINDOW_SECONDS, windowStart),
  };
};
let senderRecipientCounter: (accountId: string, to: string) => DailyCounter = realSenderRecipientCounter;

/** Tests only: replace the per-sender, per-recipient counter (pass nothing to restore it). */
export function setSenderRecipientCounterForTests(fake?: (accountId: string, to: string) => DailyCounter): void {
  senderRecipientCounter = fake ?? realSenderRecipientCounter;
}

// TS-219: what senders that don't (yet) count as the address's own planner have sent it, together
// (counted in every mode, like the per-address count).
const realUnlistedSendersCounter = (to: string): DailyCounter => {
  const key = unlistedSendersRecipientCountKey(to);
  return {
    hit: () => hitRateLimitCount(key, DAILY_WINDOW_SECONDS),
    undo: (windowStart) => undoRateLimitHit(key, DAILY_WINDOW_SECONDS, windowStart),
  };
};
let unlistedSendersCounter: (to: string) => DailyCounter = realUnlistedSendersCounter;

/**
 * TS-219: whether a wedding this account owns or helps plan has had this address for over a day,
 * unchanged -- on a guest whose address hasn't changed since, or on a pending invite made before then.
 * TS-232: by when the guest's address last changed ("emailChangedAt"), not when the row did -- an
 * edit to anything else, or the guest's own RSVP, used to make the guest look newly listed. Anyone
 * can add any address to a wedding of their own and email it straight away, so a listing made just
 * now proves nothing; one that has stood for a day means an attack had to be planned well ahead.
 */
export async function senderListsRecipient(accountId: string, to: string): Promise<boolean> {
  const { rows } = await pool.query<{ listed: boolean }>(
    `WITH mine AS (
       SELECT id FROM "weddings" WHERE "ownerId" = $1
       UNION SELECT "weddingId" FROM "wedding_collaborators" WHERE "userId" = $1
     )
     SELECT EXISTS (
              SELECT 1 FROM "guests" g
               WHERE g."weddingId" IN (SELECT id FROM mine) AND lower(trim(g.email)) = lower(trim($2))
                 AND COALESCE(g."emailChangedAt", g."createdAt") < now() - make_interval(secs => $3)
            )
         OR EXISTS (
              SELECT 1 FROM "wedding_invites" i
               WHERE i."weddingId" IN (SELECT id FROM mine) AND lower(trim(i.email)) = lower(trim($2))
                 AND i.status = 'PENDING' AND i."createdAt" < now() - make_interval(secs => $3)
            ) AS listed`,
    [accountId, to, LISTED_RECIPIENT_MIN_AGE_SECONDS]
  );
  return rows[0]?.listed ?? false;
}
let listsRecipient: (accountId: string, to: string) => Promise<boolean> = senderListsRecipient;

/** Tests only: replace the unlisted senders' counter and the "listed" lookup (pass nothing to restore them). */
export function setUnlistedSendersForTests(fakes?: {
  counter: (to: string) => DailyCounter;
  listed: (accountId: string, to: string) => Promise<boolean>;
}): void {
  unlistedSendersCounter = fakes?.counter ?? realUnlistedSendersCounter;
  listsRecipient = fakes?.listed ?? senderListsRecipient;
}

// TS-171: every email one signed-in account can make Seatwise send in a day, of every kind
// (invites, RSVP emails, notifications its actions set off), counted together. Without it, the
// separate per-kind limits added up to more than the whole day's allowance, so one account could
// stop email for everyone.
// TS-194 (Tom's decision): a new account -- in its first 7 days -- gets 20 a day instead of 100, so
// a batch of fresh accounts can't spend the site's allowance between them. TS-219: on its own that
// still let about 12 of them do it (12 x 20 = 240), so first-week accounts together are also held
// to NEW_ACCOUNTS_SHARE_OF_EVERYDAY.
// TS-203: "a day" is the last 24 hours, rolling -- it used to start again at midnight UTC, so twice
// the allowance fitted in a couple of hours. And whatever this allows, real sends are also held to
// the account's share of Seatwise's everyday allowance (ACCOUNT_SHARE_OF_EVERYDAY).
export const ACCOUNT_EMAILS_PER_DAY = { limit: 100, windowSeconds: DAILY_WINDOW_SECONDS } as const;
export const NEW_ACCOUNT_EMAILS_PER_DAY = { limit: 20, windowSeconds: DAILY_WINDOW_SECONDS } as const;
export const NEW_ACCOUNT_DAYS = 7;
export const accountDailyEmailKey = (userId: string) => `email:account:day:${userId}`;

/**
 * TS-194: the account's daily email allowance -- NEW_ACCOUNT_EMAILS_PER_DAY in its first
 * NEW_ACCOUNT_DAYS days (by when it was created), ACCOUNT_EMAILS_PER_DAY after. An account that
 * can't be found gets the smaller one.
 */
export async function accountDailyEmailLimit(userId: string): Promise<{ limit: number; windowSeconds: number; newAccount: boolean }> {
  const { rows } = await pool.query<{ isNew: boolean }>(
    `SELECT "createdAt" > now() - make_interval(days => $2) AS "isNew" FROM "users" WHERE id = $1`,
    [userId, NEW_ACCOUNT_DAYS]
  );
  const newAccount = rows[0]?.isNew ?? true;
  return { ...(newAccount ? NEW_ACCOUNT_EMAILS_PER_DAY : ACCOUNT_EMAILS_PER_DAY), newAccount };
}

/** Tests only: replace the daily email counter (pass nothing to restore it). */
export function setDailyEmailCounterForTests(fake?: DailyCounter): void {
  dailyCounter = fake ?? realDailyCounter;
}

/** Tests only: replace the real SMTP/Resend sender (pass nothing to restore it). */
export function setEmailSenderForTests(fake?: Sender): void {
  sender = fake ?? realSender;
}

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  env: EmailEnv = process.env,
  {
    essential = false,
    toWeddingMember = false,
    confirmation = false,
    unconfirmedReset = false,
    account,
    lockedOut = false,
    forGuestsOf,
    newestReset = false,
    beforeResetsBudget,
  }: {
    /**
     * A password reset for an account that has confirmed its address: counted only against the
     * resets' own budget (TS-186), and held to its own per-address limits.
     */
    essential?: boolean;
    /** TS-171: a notification to a confirmed member of the wedding -- not a stranger. */
    toWeddingMember?: boolean;
    /**
     * TS-178: an email-address confirmation (sign-up or "Resend link") -- limited to its own share
     * of the everyday allowance. TS-194: and to the per-address count for emails anyone can ask for.
     */
    confirmation?: boolean;
    /**
     * TS-186: a password reset for an unconfirmed account -- its own, smaller share of the everyday
     * allowance. TS-194: and its own per-address count.
     */
    unconfirmedReset?: boolean;
    /**
     * TS-203: the account this email is charged to -- whoever sent it. Held to that account's share
     * of the everyday allowance (real sends only), and, for an email a planner sends to someone, to
     * the account's share of what that address may receive (EMAILS_PER_RECIPIENT_PER_SENDER).
     * TS-219: never set for an email a guest set off (see `forGuestsOf`).
     */
    account?: string;
    /**
     * TS-219: an email a guest set off (an RSVP answer) in a wedding this account owns. Not charged
     * to the owner's share (TS-186: guests' answers must never use up the owner's own email) -- the
     * wedding's and the owner's pools for guests' answers (see notifications.ts) and the site's
     * limits bound it. TS-240: nor toward the first-week accounts' combined share any more.
     */
    forGuestsOf?: string;
    /**
     * TS-219: an unconfirmed account's reset that may go out even though the address's count for
     * those is full, because no reset has gone to the account for a few hours (see the
     * forgot-password route). It isn't counted on the address then -- so whoever signed up with
     * someone else's address can't use that count up and stop the address's owner getting the
     * reset that lets them take the account back.
     */
    newestReset?: boolean;
    /**
     * TS-238: for a `newestReset`, called just before it's drawn from the resets' own budget (only
     * when the unconfirmed accounts' share is full); false refuses it as Seatwise's limit. The caller
     * counts the asking network's slice of that budget here (and gives it back if nothing is sent).
     */
    beforeResetsBudget?: () => Promise<boolean>;
    /** TS-203: a reset for an account locked out by wrong passwords -- may use the resets kept for that. */
    lockedOut?: boolean;
  } = {}
): Promise<EmailResult> {
  // TS-178: addresses are masked in every log line here.
  const shown = maskEmailAddress(to);
  const config = resolveEmailTransport(env);
  // TS-200: printing an email instead of sending it is only for this machine and CI. On Netlify it
  // means the site is set up wrong (EMAIL_TRANSPORT=log copied into its settings, or not a
  // production build), and saying "logged" there would tell a planner "Emailed" when nobody was --
  // so it's refused, loudly, and the caller hears "failed".
  if (config.kind === "log" && runningOnNetlify(env)) {
    console.error(
      `[email] NOT sent to ${shown}: this server would only print the email (EMAIL_TRANSPORT=log, or not a production build), which never happens on Netlify. Remove EMAIL_TRANSPORT from the site's settings and set SMTP_USER and SMTP_PASSWORD.`
    );
    return "failed";
  }
  if (config.kind === "none") {
    console.warn(`[email] not sent to ${shown}: no email service is configured (set SMTP_USER and SMTP_PASSWORD).`);
    return "not-configured";
  }
  // TS-194: which per-address count this email goes on, if any.
  const recipientKind: RecipientCount | null =
    essential || toWeddingMember ? null : unconfirmedReset ? "unconfirmed-reset" : confirmation ? "anonymous" : "planner";
  const recipient = recipientCountAddress(to);
  // TS-178: everything this attempt has counted so far, so all of it is given back (once) when
  // nothing goes out -- refused, or failed to send.
  const counted: (() => Promise<void>)[] = [];
  const giveBack = async () => {
    for (const undo of counted.splice(0).reverse()) {
      await undo().catch((err) => console.error(`[email] couldn't give back a count: ${errorText(err)}`));
    }
  };

  // TS-178: sending never throws -- not even when the counters (in the database) can't be reached.
  // The email just isn't sent, and the caller hears "failed".
  try {
    if (recipientKind) {
      const toThisAddress = await recipientCounter.hit(recipient, recipientKind);
      counted.push(() => recipientCounter.undo(recipient, recipientKind, toThisAddress.windowStart));
      if (toThisAddress.count > RECIPIENT_LIMITS[recipientKind]) {
        // Taken back, so refused attempts don't pile up on the count.
        await giveBack();
        // TS-219: the newest reset after a quiet few hours still goes (not counted on the address).
        if (!(recipientKind === "unconfirmed-reset" && newestReset)) {
          console.warn(`[email] not sent to ${shown}: this address has had its ${recipientKind} emails from Seatwise in the last 24 hours.`);
          return "recipient-limited";
        }
      }
      // TS-203: and this account's share of them.
      if (recipientKind === "planner" && account) {
        const fromThisAccount = senderRecipientCounter(account, recipient);
        const counts = await fromThisAccount.hit();
        counted.push(() => fromThisAccount.undo(counts.windowStart));
        if (counts.count > EMAILS_PER_RECIPIENT_PER_SENDER) {
          await giveBack();
          console.warn(`[email] not sent to ${shown}: this account has sent this address its share of emails in the last 24 hours.`);
          return "recipient-limited";
        }
        // TS-219: senders whose weddings haven't long had the address share fewer of the 5, so the
        // last one is kept for the planner whose guest list really has it.
        if (!(await listsRecipient(account, to))) {
          const unlisted = unlistedSendersCounter(recipient);
          const together = await unlisted.hit();
          counted.push(() => unlisted.undo(together.windowStart));
          if (together.count > EMAILS_PER_RECIPIENT_FROM_UNLISTED_SENDERS) {
            await giveBack();
            console.warn(`[email] not sent to ${shown}: the rest of this address's emails for the last 24 hours are kept for its own planner.`);
            return "recipient-limited";
          }
        }
      }
    }
    if (config.kind === "log") {
      // TS-149: in a production build (CI's e2e server, or the live site if someone set
      // EMAIL_TRANSPORT=log) the links' secret parts are hidden, so the logs never hold a working
      // sign-in, invite, RSVP or vendor link. Local development keeps the full text, so a developer
      // can still click a link from their terminal. TS-178: the same goes for the address.
      const production = env.NODE_ENV === "production";
      const body = production ? redactLinkTokens(text) : text;
      console.log(`[email-log] to=${production ? shown : to} subject="${subject}" body="${body}"`);
      return "logged";
    }
    const limits = dailyEmailLimits(env);
    // Counts one send against `counter`; false (with everything counted so far given back) when
    // that takes it over `limit`.
    const fits = async (counter: DailyCounter, limit: number, what: string) => {
      const counts = await counter.hit();
      counted.push(() => counter.undo(counts.windowStart));
      if (counts.count <= limit) return true;
      await giveBack();
      console.warn(`[email] not sent to ${shown}: the last 24 hours' ${what} of ${limit} has been used.`);
      return false;
    };
    // TS-186: a confirmed account's reset counts only against the resets' own budget.
    // TS-203: and stops short of the resets kept for locked-out accounts, unless it's for one.
    if (essential) {
      const resetLimit = lockedOut ? limits.resets : limits.resets - limits.lockedOutResets;
      if (!(await fits(resetCounter, resetLimit, "allowance for password-reset emails"))) return "limited";
    } else if (unconfirmedReset && newestReset) {
      // TS-238: the newest reset after a quiet few hours (TS-219) for an unconfirmed account -- the
      // only way for an address's real owner to take back an account someone else signed up with.
      // It goes from the unconfirmed accounts' share as usual, but when that share (or the everyday
      // allowance) is full it's drawn from the resets' own budget instead, still short of the resets
      // kept for locked-out accounts. Before, a few networks filling the 24 kept the address's owner
      // out for good. Each network's draw on that budget is limited too (see `beforeResetsBudget`).
      const firstCounted = counted.length;
      const viaShare = async () => {
        for (const [counter, limit] of [
          [unconfirmedResetCounter, limits.unconfirmedResets],
          [dailyCounter, limits.everyday - limits.plannerFloor],
        ] as const) {
          const counts = await counter.hit();
          counted.push(() => counter.undo(counts.windowStart));
          if (counts.count > limit) return false;
        }
        return true;
      };
      if (!(await viaShare())) {
        // Only this step's counts are given back -- the address's count (if any) stays.
        for (const undo of counted.splice(firstCounted).reverse()) await undo();
        if (beforeResetsBudget && !(await beforeResetsBudget())) {
          await giveBack();
          console.warn(`[email] not sent to ${shown}: this network has had its share of the password-reset emails in the last 24 hours.`);
          return "limited";
        }
        const fromResets = limits.resets - limits.lockedOutResets;
        if (!(await fits(resetCounter, fromResets, "allowance for password-reset emails (after the unconfirmed accounts' share)"))) {
          return "limited";
        }
      }
    } else {
      if (confirmation && !(await fits(confirmationCounter, limits.confirmations, "share for email confirmations"))) return "limited";
      if (unconfirmedReset && !(await fits(unconfirmedResetCounter, limits.unconfirmedResets, "share for unconfirmed accounts' resets"))) {
        return "limited";
      }
      // TS-203: the account's share of the everyday allowance, counted before the allowance itself
      // (and refused as the account's limit, not Seatwise's).
      if (account) {
        const share = accountShareCounter(account);
        const counts = await share.hit();
        counted.push(() => share.undo(counts.windowStart));
        if (counts.count > limits.accountShare) {
          await giveBack();
          console.warn(`[email] not sent to ${shown}: the account's share of ${limits.accountShare} emails in the last 24 hours has been used.`);
          return "account-limited";
        }
      }
      // TS-232: an email a guest's answer set off -- the site-wide share for those.
      if (forGuestsOf && !account && !(await fits(guestAnswersCounter, limits.guestAnswers, "share for emails guests' answers set off"))) {
        return "limited";
      }
      // TS-219: and for an account in its first week, the first-week accounts' combined share --
      // refused as Seatwise's limit. TS-240: only for what it sends to people outside its weddings
      // (invites, RSVP links) -- not notifications to the wedding's members, nor emails its guests'
      // answers set off, which used to let one busy new planner fill the share for everyone.
      if (account && !toWeddingMember && (await accountIsNew(account))) {
        if (!(await fits(newAccountsCounter, limits.newAccounts, "share for accounts in their first week"))) return "limited";
      }
      // TS-203: only invites and RSVP links (planner-sent, to someone outside the wedding) may use
      // the last part of the everyday allowance.
      const plannerEmail = recipientKind === "planner";
      const everydayLimit = plannerEmail ? limits.everyday : limits.everyday - limits.plannerFloor;
      if (!(await fits(dailyCounter, everydayLimit, "limit for emails"))) return "limited";
    }
  } catch (err) {
    await giveBack();
    console.error(`[email] not sent to ${shown}: the email counts couldn't be checked: ${errorText(err)}`);
    return "failed";
  }
  try {
    await sender(config, { to, subject, text });
    return "sent";
  } catch (err) {
    // Never log the password or the message body -- just who and why.
    console.error(`[email] failed to send to ${shown} via ${config.kind}: ${errorText(err)}`);
    // TS-203: the server went quiet after it may have taken the message -- it may well have gone
    // out, so it stays counted (and the caller keeps any link in it working).
    if (isAmbiguousSendError(err)) return "uncertain";
    // TS-178: nothing went out, so it doesn't use up the allowance or the address's share.
    await giveBack();
    return "failed";
  }
}

// TS-178: a mail server's error often repeats the recipient ("550 <someone@example.com> rejected"),
// so any address in it is masked too.
const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/[^\s<>()"',;:@]+@[^\s<>()"',;:@]+/g, (address) => maskEmailAddress(address));

/** TS-149: hides the secret part of every Seatwise link (reset, invite, RSVP, vendor) in a text. */
export function redactLinkTokens(text: string): string {
  return text.replace(/(\/(?:reset-password|verify-email|invites|rsvp|vendor)\/)[0-9a-f]{16,}/gi, "$1[hidden]");
}
