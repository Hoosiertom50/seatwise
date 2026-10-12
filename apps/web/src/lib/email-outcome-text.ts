// TS-219: the words for an email whose outcome isn't clear -- the email service stopped answering
// after it may already have taken the message ("uncertain" in packages/db/src/email.ts). It may
// well have arrived, so it isn't called a failure ("Couldn't email ...", which was then followed by
// "Already emailed within the last hour" on the next click), but the planner is still handed the
// link in case it didn't. Kept apart from the screens so they can be unit-tested.

/** The start of the line shown when an RSVP email may have been sent; each screen adds what to do next. */
export function rsvpMaybeSentNote(email: string): string {
  return `The email to ${email} may have been sent — the email service stopped answering, so we can't be sure`;
}

/**
 * TS-241: the start of the line shown when Seatwise's own email limit (for the whole site, or a share
 * of it) held an email back. It used to read "Couldn't email ...", as if something was broken.
 */
export const SITE_EMAIL_LIMIT_NOTE = "Seatwise's email limit is reached for now, so this one wasn't sent — try again later";

/** What the Collaborators tab says after making an invite, from the invite route's answer. */
export function inviteSentMessage(
  email: string,
  res: { emailed: boolean; uncertain?: boolean; siteEmailLimited?: boolean; acceptUrl?: string }
): string {
  if (res.emailed) return `Invite sent to ${email}.`;
  if (res.siteEmailLimited) {
    return `Invite created, but ${SITE_EMAIL_LIMIT_NOTE}, or send ${email} this link yourself: ${res.acceptUrl}`;
  }
  if (res.uncertain) {
    return `Invite created. The email to ${email} may have been sent — the email service stopped answering, so we can't be sure. If they don't get it, send them this link yourself: ${res.acceptUrl}`;
  }
  return `Invite created, but the email to ${email} couldn't be sent. Send them this link yourself: ${res.acceptUrl}`;
}
