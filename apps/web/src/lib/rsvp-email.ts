import {
  claimCooldown,
  emailDelivered,
  emailMayHaveGone,
  ensureGuestRsvpToken,
  hashLinkToken,
  regenerateGuestRsvpToken,
  releaseCooldown,
  sendEmailNotification,
  type ActorAccess,
} from "@seatwise/db";
import { isRsvpCutoffPast, type RsvpEmailOutcomeDTO } from "@seatwise/shared";
import { releaseEmailSend, reserveEmailSend, RSVP_RESEND_COOLDOWN_SECONDS, rsvpLinkCooldownKey } from "./rate-limit";
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
  // TS-204: `actor` -- the access the "RSVP link" request was let in with, read again as the link
  // is made (a removed collaborator's request that was waiting doesn't get a link, or an email).
  { regenerate = false, actor }: { regenerate?: boolean; actor?: ActorAccess } = {}
): Promise<{
  url: string;
  emailed: boolean;
  emailFailed: boolean;
  emailLimited?: boolean;
  // TS-177: it was the account's daily allowance that was used up. TS-203: (rolling) -- more can go
  // out as the last 24 hours' emails age out, not "tomorrow".
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
    ? await regenerateGuestRsvpToken(guest.id, wedding.id, actor)
    : await ensureGuestRsvpToken(guest.id, wedding.id, actor);
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
  // TS-186: a real hour since it was last emailed -- refused clicks don't push it back -- and kept
  // per link, so after "Reset all guest and vendor links" the new link can be emailed at once.
  const cooldownKey = rsvpLinkCooldownKey(guest.id, guest.email, hashLinkToken(token));
  const cooldown = await claimCooldown(cooldownKey, RSVP_RESEND_COOLDOWN_SECONDS);
  if (!regenerate && !cooldown.allowed) return { url, emailed: false, emailFailed: false, recentlyEmailed: true };
  const notSent = async () => {
    if (cooldown.claimedAt) await releaseCooldown(cooldownKey, cooldown.claimedAt);
  };

  // TS-177: a refused reservation has already given back its own counts (see reserveEmailSend);
  // only the hourly cooldown needs giving back here.
  // TS-203: and if counting fails outright (the database unreachable), the cooldown is given back
  // too -- before, it stayed, and the link couldn't be emailed again for an hour.
  let reservation: Awaited<ReturnType<typeof reserveEmailSend>>;
  try {
    reservation = await reserveEmailSend("rsvpEmails", sender.id);
  } catch (err) {
    await notSent().catch(() => {});
    throw err;
  }
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
  // TS-203: charged to the planner's account (its share of Seatwise's email, and of what one address may receive).
  const result = await sendEmailNotification(guest.email, subject, text, { account: sender.id });
  const emailed = emailDelivered(result);
  // TS-203: "uncertain" -- the mail server went quiet after it may have taken the email -- keeps
  // its counts and the hour's cooldown (it may well have arrived), though the planner is told it
  // may not have, with the link to send themselves.
  if (!emailMayHaveGone(result)) {
    await notSent();
    // TS-171 / TS-178: nothing went out -- whatever the reason (this address's share used up, the
    // day's limit, a failed send) -- so it doesn't use up the planner's allowance either.
    await releaseEmailSend("rsvpEmails", sender.id, reservation);
  }
  if (result === "recipient-limited") return { url, emailed: false, emailFailed: true, recipientLimited: true };
  // TS-203: the account's share of Seatwise's email is used up for now -- more in the next 24 hours.
  if (result === "account-limited") return { url, emailed: false, emailFailed: true, emailLimited: true, emailLimitedToday: true };
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
