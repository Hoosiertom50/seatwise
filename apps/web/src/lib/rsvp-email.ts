import { ensureGuestRsvpToken, regenerateGuestRsvpToken, sendEmailNotification, emailDelivered } from "@seatwise/db";
import { reserveEmailSend } from "./rate-limit";
import { emailSafePersonName, emailSafeWeddingName } from "./email-safe-names";

// TS-17 / TS-143: email a guest their own RSVP link. Shared by the "RSVP link" button and by
// adding a guest with an email (or giving an existing guest their first email), so the message is
// identical either way. Never throws: a failed email is reported, never fatal.
//
// TS-156: `senderId` is the signed-in planner; once they've sent too many RSVP emails in a short
// time, the link is still made but not emailed (`emailLimited`), so they can send it themselves.
export async function sendGuestRsvpLink(
  guest: { id: string; firstName: string; email: string | null },
  wedding: { id: string; name: string; rsvpCutoffDate: string | null },
  senderId: string,
  { regenerate = false }: { regenerate?: boolean } = {}
): Promise<{ url: string; emailed: boolean; emailFailed: boolean; emailLimited?: boolean } | null> {
  const token = regenerate
    ? await regenerateGuestRsvpToken(guest.id, wedding.id)
    : await ensureGuestRsvpToken(guest.id, wedding.id);
  if (!token) return null;

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const url = `${appUrl}/rsvp/${token}`;
  if (!guest.email) return { url, emailed: false, emailFailed: false };
  if (!(await reserveEmailSend("rsvpEmails", senderId))) {
    return { url, emailed: false, emailFailed: true, emailLimited: true };
  }

  const cutoffNote = wedding.rsvpCutoffDate ? ` Please respond by ${wedding.rsvpCutoffDate}.` : "";
  // TS-163: names saved before today's rules only go into the email if they still pass them.
  const firstName = emailSafePersonName(guest.firstName);
  const weddingName = emailSafeWeddingName(wedding.name);
  const result = await sendEmailNotification(
    guest.email,
    weddingName ? `RSVP for ${weddingName}` : "Please RSVP",
    `${firstName ? `Hi ${firstName}` : "Hi"},\n\nPlease RSVP${weddingName ? ` for "${weddingName}"` : ""} here: ${url}\n\nIf you've already responded, this same link shows what you submitted and lets you update it.${cutoffNote}`
  );
  const emailed = emailDelivered(result);
  return { url, emailed, emailFailed: !emailed };
}
