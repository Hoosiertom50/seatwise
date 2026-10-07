import type { EmailResult } from "@seatwise/db";
import { EMAIL_NOT_SET_UP_MESSAGE } from "./email-verification-text";

// TS-142 / TS-145: what the "Forgot password?" form tells the person. Plain about a missing account
// (Tom's decision, 2026-10-02), and honest when the email didn't actually go out -- never "we've
// sent a link" unless it was sent.
export const RESET_SENT_MESSAGE =
  "We've sent a link to reset your password. It works for 1 hour. Check your spam or junk folder if it doesn't arrive.";
export const RESET_NO_ACCOUNT_MESSAGE = "There's no Seatwise account for that email. Check the spelling, or sign up instead.";
export const RESET_EMAIL_FAILED_MESSAGE = "We couldn't send the email just now — please try again in a few minutes.";
// TS-177: asking again while the last link still works sends nothing new (TS-171) -- so say that,
// rather than "we've sent a link", which reads as if another email is on the way.
export const RESET_ALREADY_SENT_MESSAGE =
  "We've already sent you a link to reset your password, and it still works. Check your email, including the spam or junk folder. Links last 1 hour; you can ask for a new one after that.";
// TS-177: the email allowance is used up -- trying again in a few minutes won't help.
// TS-194: it rolls over 24 hours now, so room comes back during the day. TS-203: "a few hours"
// wasn't true after a burst (it can be up to a day) -- say what's true.
export const RESET_EMAIL_LIMITED_MESSAGE =
  "Seatwise has sent as many emails as it can for now — room comes back as emails from the last 24 hours age out, so please try again later (within about a day).";
// TS-194: the site has no email service set up -- trying again won't help either.
export const RESET_EMAIL_NOT_SET_UP_MESSAGE = EMAIL_NOT_SET_UP_MESSAGE;
// TS-186: it's this address's share that's used up, not Seatwise's -- say that. TS-203: over the
// last 24 hours (rolling), not "today".
export const RESET_RECIPIENT_LIMITED_MESSAGE =
  "This email address has had as many emails from Seatwise as it can in the last 24 hours — please try again within about a day.";
// TS-203: the mail server stopped answering after it may have taken the email -- it may well arrive,
// and its link works, so asking again now would only say "already sent".
export const RESET_MAYBE_SENT_MESSAGE =
  "We may have sent you a link to reset your password — the email service stopped answering before it confirmed. Check your email in a few minutes, including the spam or junk folder. The link works for 1 hour; if nothing arrives, you can ask for a new one after that.";

export type ResetOutcome =
  | { sent: true; message: string; alreadySent?: true; uncertain?: true }
  | { sent: false; noAccount: true; message: string }
  | { sent: false; emailFailed: true; message: string };

export function resetOutcome(hasAccount: boolean, email: EmailResult | "already-sent" | null): ResetOutcome {
  if (!hasAccount) return { sent: false, noAccount: true, message: RESET_NO_ACCOUNT_MESSAGE };
  if (email === "already-sent") return { sent: true, alreadySent: true, message: RESET_ALREADY_SENT_MESSAGE };
  if (email === "sent" || email === "logged") return { sent: true, message: RESET_SENT_MESSAGE };
  if (email === "uncertain") return { sent: true, uncertain: true, message: RESET_MAYBE_SENT_MESSAGE };
  if (email === "recipient-limited") return { sent: false, emailFailed: true, message: RESET_RECIPIENT_LIMITED_MESSAGE };
  if (email === "limited") return { sent: false, emailFailed: true, message: RESET_EMAIL_LIMITED_MESSAGE };
  if (email === "not-configured") return { sent: false, emailFailed: true, message: RESET_EMAIL_NOT_SET_UP_MESSAGE };
  return { sent: false, emailFailed: true, message: RESET_EMAIL_FAILED_MESSAGE };
}
