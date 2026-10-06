import { createEmailVerificationToken, EMAIL_VERIFICATION_TTL_HOURS, sendEmail, type EmailResult } from "@seatwise/db";
import { emailSafePersonName } from "./email-safe-names";
import { verificationEmailBody } from "./email-verification-text";

// TS-177: the messages live in email-verification-text.ts (re-exported here for the routes).
export { confirmEmailFirstMessage, confirmEmailToAcceptMessage, emailNotSentMessage } from "./email-verification-text";

// TS-164: emails the account's owner a link to confirm their address. Never throws -- a failed
// email is reported (they can ask for another from the banner), never fatal to signing up.
// TS-177: returns what happened (not just yes/no), so "Resend link" can say why one didn't go out.
export async function sendVerificationEmail(user: { id: string; name: string; email: string }): Promise<EmailResult> {
  const token = await createEmailVerificationToken(user.id);
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const name = emailSafePersonName(user.name);
  // TS-171: an everyday email, no longer sharing the headroom kept for password resets -- anyone
  // can sign up with someone else's address, so these could otherwise use that headroom up. On a
  // day the allowance runs out, "Resend link" works again tomorrow.
  return sendEmail(
    user.email,
    "Confirm your email for Seatwise",
    verificationEmailBody({ name, link: `${appUrl}/verify-email/${token}`, hours: EMAIL_VERIFICATION_TTL_HOURS })
  );
}
