import type { EmailResult } from "@seatwise/db";

// TS-142 / TS-145: what the "Forgot password?" form tells the person. Plain about a missing account
// (Tom's decision, 2026-10-02), and honest when the email didn't actually go out -- never "we've
// sent a link" unless it was sent.
export const RESET_SENT_MESSAGE =
  "We've sent a link to reset your password. It works for 1 hour. Check your spam or junk folder if it doesn't arrive.";
export const RESET_NO_ACCOUNT_MESSAGE = "There's no Seatwise account for that email. Check the spelling, or sign up instead.";
export const RESET_EMAIL_FAILED_MESSAGE = "We couldn't send the email just now — please try again in a few minutes.";

export type ResetOutcome =
  | { sent: true; message: string }
  | { sent: false; noAccount: true; message: string }
  | { sent: false; emailFailed: true; message: string };

export function resetOutcome(hasAccount: boolean, email: EmailResult | null): ResetOutcome {
  if (!hasAccount) return { sent: false, noAccount: true, message: RESET_NO_ACCOUNT_MESSAGE };
  if (email === "sent" || email === "logged") return { sent: true, message: RESET_SENT_MESSAGE };
  return { sent: false, emailFailed: true, message: RESET_EMAIL_FAILED_MESSAGE };
}
