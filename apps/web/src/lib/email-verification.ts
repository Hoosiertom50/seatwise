import { createEmailVerificationToken, EMAIL_VERIFICATION_TTL_HOURS, emailDelivered, sendEmail } from "@seatwise/db";
import { emailSafePersonName } from "./email-safe-names";

// TS-164: emails the account's owner a link to confirm their address. Never throws -- a failed
// email is reported (they can ask for another from the banner), never fatal to signing up.
export async function sendVerificationEmail(user: { id: string; name: string; email: string }): Promise<boolean> {
  const token = await createEmailVerificationToken(user.id);
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const name = emailSafePersonName(user.name);
  // TS-171: an everyday email, no longer sharing the headroom kept for password resets -- anyone
  // can sign up with someone else's address, so these could otherwise use that headroom up. On a
  // day the allowance runs out, "Resend link" works again tomorrow.
  const result = await sendEmail(
    user.email,
    "Confirm your email for Seatwise",
    `${name ? `Hi ${name}` : "Hi"},\n\nPlease confirm this is your email address for Seatwise:\n\n${appUrl}/verify-email/${token}\n\nThis link works for ${EMAIL_VERIFICATION_TTL_HOURS} hours. Until you confirm, Seatwise won't send invites or RSVP emails from your account. If you didn't sign up for Seatwise, you can ignore this email.`
  );
  return emailDelivered(result);
}

/** TS-164: what a not-yet-confirmed account is told when it tries to email someone. */
export function confirmEmailFirstMessage(email: string): string {
  return `Confirm your email address first — we sent a link to ${email}. (Check spam, or use "Resend link" at the top of the page.)`;
}
