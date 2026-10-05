import { emailSafePersonName, emailSafeWeddingName } from "./email-safe-names";

// TS-171: what Seatwise says to people outside a wedding -- a guest getting their RSVP link, someone
// invited to help plan. The subject line is always fixed: it's what shows in an inbox before
// anything is opened, so nothing a planner typed goes there. In the body, the wedding's name is
// quoted and called a name ("a wedding named “…” on Seatwise"), so it reads as what someone called
// their wedding, not as a message from Seatwise.

export const RSVP_EMAIL_SUBJECT = "Please RSVP — your wedding invitation on Seatwise";
export const INVITE_EMAIL_SUBJECT = "You've been invited to plan a wedding on Seatwise";

/** "a wedding named “Ana & Bo”", or just "a wedding" when the name can't go in an email. */
export function quotedWeddingName(name: string): string {
  const safe = emailSafeWeddingName(name);
  return safe ? `a wedding named “${safe}”` : "a wedding";
}

export function rsvpEmailText(input: {
  guestFirstName: string;
  weddingName: string;
  url: string;
  rsvpCutoffDate: string | null;
}): { subject: string; text: string } {
  // TS-163: names saved before today's rules only go into the email if they still pass them.
  const firstName = emailSafePersonName(input.guestFirstName);
  const cutoffNote = input.rsvpCutoffDate ? ` Please respond by ${input.rsvpCutoffDate}.` : "";
  return {
    subject: RSVP_EMAIL_SUBJECT,
    text: `${firstName ? `Hi ${firstName}` : "Hi"},\n\nYou've been asked to RSVP for ${quotedWeddingName(input.weddingName)} on Seatwise. Respond here: ${input.url}\n\nIf you've already responded, this same link shows what you submitted and lets you update it.${cutoffNote}`,
  };
}

export function inviteEmailText(input: {
  inviterName: string;
  weddingName: string;
  roleLabel: string;
  permissionLevel: string;
  acceptUrl: string;
}): { subject: string; text: string } {
  // TS-156: the inviter's own name only goes into the email if it reads as a name -- accounts
  // made before the signup rule tightened could hold anything.
  const inviter = emailSafePersonName(input.inviterName);
  return {
    subject: INVITE_EMAIL_SUBJECT,
    text: `${inviter ? `${inviter} invited you` : "You've been invited"} to join ${quotedWeddingName(input.weddingName)} on Seatwise as ${input.roleLabel} with ${input.permissionLevel.toLowerCase()} access.\n\nAccept the invite: ${input.acceptUrl}\n\nThis link expires in 7 days. If you weren't expecting this, you can ignore it.`,
  };
}
