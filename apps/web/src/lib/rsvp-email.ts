import { ensureGuestRsvpToken, regenerateGuestRsvpToken, sendEmailNotification, emailDelivered } from "@seatwise/db";

// TS-17 / TS-143: email a guest their own RSVP link. Shared by the "RSVP link" button and by
// adding a guest with an email (or giving an existing guest their first email), so the message is
// identical either way. Never throws: a failed email is reported, never fatal.
export async function sendGuestRsvpLink(
  guest: { id: string; firstName: string; email: string | null },
  wedding: { id: string; name: string; rsvpCutoffDate: string | null },
  { regenerate = false }: { regenerate?: boolean } = {}
): Promise<{ url: string; emailed: boolean; emailFailed: boolean } | null> {
  const token = regenerate
    ? await regenerateGuestRsvpToken(guest.id, wedding.id)
    : await ensureGuestRsvpToken(guest.id, wedding.id);
  if (!token) return null;

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const url = `${appUrl}/rsvp/${token}`;
  if (!guest.email) return { url, emailed: false, emailFailed: false };

  const cutoffNote = wedding.rsvpCutoffDate ? ` Please respond by ${wedding.rsvpCutoffDate}.` : "";
  const result = await sendEmailNotification(
    guest.email,
    `RSVP for ${wedding.name}`,
    `Hi ${guest.firstName},\n\nPlease RSVP for "${wedding.name}" here: ${url}\n\nIf you've already responded, this same link shows what you submitted and lets you update it.${cutoffNote}`
  );
  const emailed = emailDelivered(result);
  return { url, emailed, emailFailed: !emailed };
}
