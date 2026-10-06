import type { EmailResult } from "@seatwise/db";

// TS-177: the words an account sees about confirming its email address, in one place (and free of
// database code, so they can be unit-tested). None of them claims a link was sent: the sign-up
// email can fail, or be held back once the day's email allowance is used up (TS-171).

/** The confirmation email's body. TS-178: just "Hi," -- the name was typed by whoever signed up,
 * who may not be the address's owner, so it isn't put in front of them. */
export function verificationEmailBody({ link, hours }: { link: string; hours: number }): string {
  return (
    `Hi,\n\nPlease confirm this is your email address for Seatwise:\n\n${link}\n\n` +
    `This link works for ${hours} hours. Until you confirm, Seatwise won't send invites or RSVP emails from your ` +
    `account, or email you notifications. If you didn't sign up for Seatwise, you can ignore this email.`
  );
}

/** TS-164: what a not-yet-confirmed account is told when it tries to email someone. */
export function confirmEmailFirstMessage(): string {
  return `Confirm your email address first — use the link we email you, or "Resend link" at the top of the page if it hasn't arrived (check spam too).`;
}

/** TS-164: what a not-yet-confirmed account is told when it tries to accept an invite. */
export function confirmEmailToAcceptMessage(): string {
  return `Confirm your email address to accept this invite — use the link we email you, or "Resend link" at the top of the page if it hasn't arrived (check spam too). Then come back to this page.`;
}

/** TS-177: why "Resend link" didn't send -- "a few minutes" only when that's when it could work. */
export function emailNotSentMessage(result: EmailResult): string {
  if (result === "recipient-limited") return "This address has had as many emails from Seatwise as it can today — please try again tomorrow.";
  if (result === "limited") return "Seatwise can't send any more emails today — please try again tomorrow.";
  return "We couldn't send the email just now — please try again in a few minutes.";
}
