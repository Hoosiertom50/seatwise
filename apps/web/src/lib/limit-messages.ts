// TS-177: the words shown when a rate limit refuses something, kept apart from ./rate-limit (which
// needs the database) so they can be unit-tested. Each one has to match how long the wait really
// is -- a daily limit used to say "wait a few minutes", and the account's daily email allowance
// used to say "a lot of invites in a short time".

// The generic "too many" text for a limit counted per network address.
export function tooManyAttemptsMessage(windowSeconds: number): string {
  if (windowSeconds >= 86_400) return "You've reached today's limit for this — please try again tomorrow.";
  if (windowSeconds >= 3600) return "Too many attempts from here in a short time — please try again in about an hour.";
  return "Too many attempts from here in a short time. Please wait a few minutes and try again.";
}

// The RSVP per-link limit counts submits on one guest's link from anywhere, so not "from here".
export const RSVP_LINK_TOO_MANY_SUBMITS =
  "This RSVP has been sent many times in the last few minutes — please wait a few minutes and try again.";

export type EmailKind = "invites" | "rsvpEmails";

// TS-178: the daily cap on new weddings per account (WEDDING_CREATE_LIMITS in ./rate-limit).
export const TOO_MANY_WEDDINGS_TODAY = "You've created a lot of weddings today — you can create more tomorrow.";

export const TOO_MANY_INVITES =
  "You've sent a lot of invites in a short time. Please wait a while before sending more.";
export const ACCOUNT_DAILY_EMAIL_LIMIT_REACHED =
  "You've reached today's email limit for your account — you can send more tomorrow.";
// TS-194: a new account (its first 7 days) has a smaller daily allowance -- say so, so it doesn't
// look like a fault.
export const NEW_ACCOUNT_DAILY_EMAIL_LIMIT_REACHED =
  "New accounts can send up to 20 emails a day in their first week, and you've reached today's — you can send more tomorrow.";
const TODAYS_INVITES_REACHED = "You've reached today's limit for invites — you can send more tomorrow.";
const TOO_MANY_EMAILS = "You've sent a lot of emails in a short time. Please wait a while before sending more.";

/**
 * Which limit refused an email: "account-day" = the account's daily allowance for every kind of
 * email together; "new-account-day" = the same, for an account in its first week (TS-194);
 * "day" = this kind's own daily window; "short" = only windows shorter than a day.
 */
export type EmailLimitReason = "account-day" | "new-account-day" | "day" | "short";

/** Picks the reason from the windows that refused. Any full daily window means no more today. */
export function emailLimitReason(
  refused: { windowSeconds: number; accountDaily: boolean; newAccount?: boolean }[]
): EmailLimitReason {
  if (refused.some((c) => c.accountDaily && c.newAccount)) return "new-account-day";
  if (refused.some((c) => c.accountDaily)) return "account-day";
  if (refused.some((c) => c.windowSeconds >= 86_400)) return "day";
  return "short";
}

/** The message for an email of `kind` refused for `reason`. */
export function emailSendRefusedMessage(kind: EmailKind, reason: EmailLimitReason): string {
  if (reason === "new-account-day") return NEW_ACCOUNT_DAILY_EMAIL_LIMIT_REACHED;
  if (reason === "account-day") return ACCOUNT_DAILY_EMAIL_LIMIT_REACHED;
  if (reason === "day") return kind === "invites" ? TODAYS_INVITES_REACHED : ACCOUNT_DAILY_EMAIL_LIMIT_REACHED;
  return kind === "invites" ? TOO_MANY_INVITES : TOO_MANY_EMAILS;
}
