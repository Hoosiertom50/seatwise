import { createEmailVerificationToken, EMAIL_VERIFICATION_TTL_HOURS, sendEmail, type EmailResult } from "@seatwise/db";
import { appBaseUrl } from "./app-url";
import { verificationEmailBody } from "./email-verification-text";

// TS-177: the messages live in email-verification-text.ts (re-exported here for the routes).
export { confirmEmailFirstMessage, confirmEmailToAcceptMessage, emailNotSentMessage } from "./email-verification-text";

// TS-164: emails the account's owner a link to confirm their address. Never throws -- a failed
// email is reported (they can ask for another from the banner), never fatal to signing up.
// TS-177: returns what happened (not just yes/no), so "Resend link" can say why one didn't go out.
export async function sendVerificationEmail(user: { id: string; email: string }): Promise<EmailResult> {
  let appUrl: string;
  try {
    appUrl = appBaseUrl();
  } catch (err) {
    // TS-178: no proper address for the link on this deployment -- reported, not sent.
    console.error(`[email] confirmation not sent: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
  // TS-186: "never throws" includes the database being unreachable while the link is made -- the
  // account is still created, and the person can ask for another link from the banner.
  let token: string;
  try {
    token = await createEmailVerificationToken(user.id);
  } catch (err) {
    console.error(`[email] confirmation not sent: the link couldn't be made: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
  // TS-171: an everyday email, no longer sharing the headroom kept for password resets -- anyone
  // can sign up with someone else's address, so these could otherwise use that headroom up. On a
  // day the allowance runs out, "Resend link" works again tomorrow.
  // TS-178: and only out of its own share of that allowance (`confirmation`), so sign-ups can't
  // crowd out invites and RSVP emails. The greeting no longer uses the name typed at sign-up:
  // whoever signs up with someone else's address chooses that name.
  return sendEmail(
    user.email,
    "Confirm your email for Seatwise",
    verificationEmailBody({ link: `${appUrl}/verify-email/${token}`, hours: EMAIL_VERIFICATION_TTL_HOURS }),
    process.env,
    { confirmation: true }
  );
}
