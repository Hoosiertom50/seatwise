// TS-177: the words shown when a rate limit refuses something, kept apart from ./rate-limit (which
// needs the database) so they can be unit-tested. Each one has to match how long the wait really
// is -- a daily limit used to say "wait a few minutes", and the account's daily email allowance
// used to say "a lot of invites in a short time".
//
// TS-203: limits of a day now roll over the last 24 hours (they used to start again at midnight
// UTC -- 8 pm Eastern -- which is what "today" and "tomorrow" really meant). So none of these says
// "today" or "tomorrow" any more: they say "the last 24 hours", and how long the wait is when it's
// known (worked out from the counts, see rollingRetryAfterSeconds).

/**
 * TS-203: when to try again, in words -- "in under an hour", "in about 5 hours" -- from the seconds
 * until it would be allowed. Without that, "within about a day" (the longest a rolling count holds
 * on to anything is 25 hours).
 */
export function tryAgainIn(retryAfterSeconds?: number): string {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return "within about a day";
  if (retryAfterSeconds <= 3600) return "in under an hour";
  const hours = Math.ceil(retryAfterSeconds / 3600);
  return hours >= 24 ? "in about a day" : `in about ${hours} hours`;
}

// The generic "too many" text for a limit counted per network address.
export function tooManyAttemptsMessage(windowSeconds: number, retryAfterSeconds?: number): string {
  if (windowSeconds >= 86_400) {
    return `You've reached the limit for this in the last 24 hours — please try again ${tryAgainIn(retryAfterSeconds)}.`;
  }
  if (windowSeconds >= 3600) return "Too many attempts from here in a short time — please try again in about an hour.";
  return "Too many attempts from here in a short time. Please wait a few minutes and try again.";
}

// The RSVP per-link limit counts submits on one guest's link from anywhere, so not "from here".
export const RSVP_LINK_TOO_MANY_SUBMITS =
  "This RSVP has been sent many times in the last few minutes — please wait a few minutes and try again.";

export type EmailKind = "invites" | "rsvpEmails";

// TS-178: the cap on new weddings per account (WEDDING_CREATE_LIMITS in ./rate-limit).
// TS-203: over the last 24 hours, with the real wait.
export function TOO_MANY_WEDDINGS_TODAY(retryAfterSeconds?: number): string {
  return `You've created a lot of weddings in the last 24 hours — you can create more ${tryAgainIn(retryAfterSeconds)}.`;
}

export const TOO_MANY_INVITES =
  "You've sent a lot of invites in a short time. Please wait a while before sending more.";
// TS-203: the account's allowance rolls over 24 hours.
export function ACCOUNT_DAILY_EMAIL_LIMIT_REACHED(retryAfterSeconds?: number): string {
  return `You've reached your account's email limit for the last 24 hours — you can send more ${tryAgainIn(retryAfterSeconds)}.`;
}
// TS-194: a new account (its first 7 days) has a smaller allowance -- say so, so it doesn't look
// like a fault.
export function NEW_ACCOUNT_DAILY_EMAIL_LIMIT_REACHED(retryAfterSeconds?: number): string {
  return `New accounts can send up to 20 emails in any 24 hours during their first week, and you've reached that — you can send more ${tryAgainIn(retryAfterSeconds)}.`;
}
const invitesDayReached = (retryAfterSeconds?: number) =>
  `You've reached the limit for invites in the last 24 hours — you can send more ${tryAgainIn(retryAfterSeconds)}.`;
const TOO_MANY_EMAILS = "You've sent a lot of emails in a short time. Please wait a while before sending more.";

/**
 * Which limit refused an email: "account-day" = the account's 24-hour allowance for every kind of
 * email together; "new-account-day" = the same, for an account in its first week (TS-194);
 * "day" = this kind's own 24-hour window; "short" = only windows shorter than a day.
 */
export type EmailLimitReason = "account-day" | "new-account-day" | "day" | "short";

/** Picks the reason from the windows that refused. Any full daily window means a wait of hours. */
export function emailLimitReason(
  refused: { windowSeconds: number; accountDaily: boolean; newAccount?: boolean }[]
): EmailLimitReason {
  if (refused.some((c) => c.accountDaily && c.newAccount)) return "new-account-day";
  if (refused.some((c) => c.accountDaily)) return "account-day";
  if (refused.some((c) => c.windowSeconds >= 86_400)) return "day";
  return "short";
}

/** The message for an email of `kind` refused for `reason` (TS-203: with the wait, when known). */
export function emailSendRefusedMessage(kind: EmailKind, reason: EmailLimitReason, retryAfterSeconds?: number): string {
  if (reason === "new-account-day") return NEW_ACCOUNT_DAILY_EMAIL_LIMIT_REACHED(retryAfterSeconds);
  if (reason === "account-day") return ACCOUNT_DAILY_EMAIL_LIMIT_REACHED(retryAfterSeconds);
  if (reason === "day") return kind === "invites" ? invitesDayReached(retryAfterSeconds) : ACCOUNT_DAILY_EMAIL_LIMIT_REACHED(retryAfterSeconds);
  return kind === "invites" ? TOO_MANY_INVITES : TOO_MANY_EMAILS;
}

// TS-205: the hourly limits on heavy work inside a wedding, per account (WEDDING_WORK_LIMITS in
// ./rate-limit). Each says what there was a lot of, and that it's about an hour's wait.
export type WeddingWorkKind = "generate" | "restore" | "importCommit" | "saveTemplate" | "comment";

const WEDDING_WORK_WHAT: Record<WeddingWorkKind, string> = {
  generate: "made a lot of seating plans",
  restore: "restored a lot of plan versions",
  importCommit: "imported a lot of guest lists",
  saveTemplate: "saved a lot of templates",
  comment: "posted a lot of comments",
};

export function tooMuchWeddingWorkMessage(kind: WeddingWorkKind): string {
  return `You've ${WEDDING_WORK_WHAT[kind]} in the last hour — please wait a while and try again.`;
}
/**
 * TS-203: the account's share of Seatwise's whole email allowance (every kind of email it sends or
 * its weddings' guests set off, together) is used up for now.
 */
export const ACCOUNT_SHARE_OF_EMAIL_REACHED =
  "Your account has sent its share of Seatwise's emails for the last 24 hours — more can go out within about a day.";

/** TS-203: one address has had as many emails from Seatwise (or from this account) as it can for now. */
export const RECIPIENT_LIMITED_MESSAGE =
  "This email address has had as many emails from Seatwise as it can in the last 24 hours — please try again within about a day.";
