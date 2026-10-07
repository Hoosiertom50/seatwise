// TS-219: the words for an email whose outcome isn't clear -- the email service stopped answering
// after it may already have taken the message ("uncertain" in packages/db/src/email.ts). It may
// well have arrived, so it isn't called a failure ("Couldn't email ...", which was then followed by
// "Already emailed within the last hour" on the next click), but the planner is still handed the
// link in case it didn't. Kept apart from the screens so they can be unit-tested.

/** The start of the line shown when an RSVP email may have been sent; each screen adds what to do next. */
export function rsvpMaybeSentNote(email: string): string {
  return `The email to ${email} may have been sent — the email service stopped answering, so we can't be sure`;
}

/** What the Collaborators tab says after making an invite, from the invite route's answer. */
export function inviteSentMessage(email: string, res: { emailed: boolean; uncertain?: boolean; acceptUrl?: string }): string {
  if (res.emailed) return `Invite sent to ${email}.`;
  if (res.uncertain) {
    return `Invite created. The email to ${email} may have been sent — the email service stopped answering, so we can't be sure. If they don't get it, send them this link yourself: ${res.acceptUrl}`;
  }
  return `Invite created, but the email to ${email} couldn't be sent. Send them this link yourself: ${res.acceptUrl}`;
}
