import { ensureGuestRsvpToken, regenerateGuestRsvpToken, sendEmailNotification, emailDelivered, hitRateLimit, undoRateLimitHit } from "@seatwise/db";
import { isRsvpCutoffPast, type RsvpEmailOutcomeDTO } from "@seatwise/shared";
import { releaseEmailSend, reserveEmailSend, RSVP_RESEND_COOLDOWN_SECONDS } from "./rate-limit";
import { rsvpEmailText } from "./outgoing-email-text";
import { appBaseUrl } from "./app-url";

// TS-17 / TS-143: email a guest their own RSVP link. Shared by the "RSVP link" button and by
// adding a guest with an email (or giving an existing guest their first email), so the message is
// identical either way. A failed email is reported, never fatal (TS-178: it throws only when the
// live site has no proper APP_URL to build the link from).
//
// TS-156: `senderId` is the signed-in planner; once they've sent too many RSVP emails in a short
// time, the link is still made but not emailed (`emailLimited`), so they can send it themselves.
export async function sendGuestRsvpLink(
  guest: { id: string; firstName: string; email: string | null },
  wedding: { id: string; name: string; rsvpCutoffDate: string | null },
  sender: { id: string; emailVerifiedAt: Date | null },
  { regenerate = false }: { regenerate?: boolean } = {}
): Promise<{
  url: string;
  emailed: boolean;
  emailFailed: boolean;
  emailLimited?: boolean;
  // TS-177: it was the account's daily allowance that was used up -- more can go out tomorrow.
  emailLimitedToday?: boolean;
  confirmEmailFirst?: boolean;
  recentlyEmailed?: boolean;
  recipientLimited?: boolean;
  rsvpClosed?: boolean;
} | null> {
  // TS-178: worked out first -- on a live site without a proper APP_URL this throws before any
  // link is changed (see ./app-url).
  const appUrl = appBaseUrl();
  const token = regenerate
    ? await regenerateGuestRsvpToken(guest.id, wedding.id)
    : await ensureGuestRsvpToken(guest.id, wedding.id);
  if (!token) return null;

  const url = `${appUrl}/rsvp/${token}`;
  if (!guest.email) return { url, emailed: false, emailFailed: false };
  // TS-177 (Tom's decision): once the RSVP cutoff has passed, the link would only open a "closed"
  // page, so Seatwise doesn't email it -- the planner can still copy it and send it if they choose.
  // Checked before any limit, so it uses up neither the allowance nor the hourly cooldown.
  if (isRsvpCutoffPast(wedding.rsvpCutoffDate)) return { url, emailed: false, emailFailed: false, rsvpClosed: true };
  // TS-164: an account that hasn't confirmed its own address can't have Seatwise email people. The
  // link is still made, so the planner can send it themselves.
  if (sender.emailVerifiedAt === null) return { url, emailed: false, emailFailed: true, confirmEmailFirst: true };

  // TS-171: the same link to the same address goes out at most once an hour (see
  // RSVP_RESEND_COOLDOWN_SECONDS); a new link always goes, and starts the hour again.
  const cooldownKey = `email:rsvp-link:${guest.id}:${guest.email.trim().toLowerCase()}`;
  const firstThisHour = (await hitRateLimit(cooldownKey, 1, RSVP_RESEND_COOLDOWN_SECONDS)).allowed;
  if (!regenerate && !firstThisHour) return { url, emailed: false, emailFailed: false, recentlyEmailed: true };
  const notSent = async () => {
    if (firstThisHour) await undoRateLimitHit(cooldownKey, RSVP_RESEND_COOLDOWN_SECONDS);
  };

  // TS-177: a refused reservation has already given back its own counts (see reserveEmailSend);
  // only the hourly cooldown needs giving back here.
  const reservation = await reserveEmailSend("rsvpEmails", sender.id);
  if (!reservation.allowed) {
    await notSent();
    return {
      url,
      emailed: false,
      emailFailed: true,
      emailLimited: true,
      emailLimitedToday: reservation.reason !== "short",
    };
  }

  const { subject, text } = rsvpEmailText({
    guestFirstName: guest.firstName,
    weddingName: wedding.name,
    url,
    rsvpCutoffDate: wedding.rsvpCutoffDate,
  });
  const result = await sendEmailNotification(guest.email, subject, text);
  const emailed = emailDelivered(result);
  if (!emailed) {
    await notSent();
    // TS-171 / TS-178: nothing went out -- whatever the reason (this address's share used up, the
    // day's limit, a failed send) -- so it doesn't use up the planner's allowance either.
    await releaseEmailSend("rsvpEmails", sender.id);
  }
  if (result === "recipient-limited") return { url, emailed: false, emailFailed: true, recipientLimited: true };
  return { url, emailed, emailFailed: !emailed };
}

// TS-143 / TS-177: the outcome as the guest routes report it (every flag spelled out), so adding a
// guest and editing one say exactly the same things.
export function rsvpEmailOutcome(
  sent: NonNullable<Awaited<ReturnType<typeof sendGuestRsvpLink>>>
): RsvpEmailOutcomeDTO {
  return {
    emailed: sent.emailed,
    emailFailed: sent.emailFailed,
    emailLimited: sent.emailLimited ?? false,
    emailLimitedToday: sent.emailLimitedToday ?? false,
    confirmEmailFirst: sent.confirmEmailFirst ?? false,
    recentlyEmailed: sent.recentlyEmailed ?? false,
    recipientLimited: sent.recipientLimited ?? false,
    rsvpClosed: sent.rsvpClosed ?? false,
  };
}
