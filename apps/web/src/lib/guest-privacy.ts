// TS-154 (Tom's decision #1, 2026-10-02): a guest's private notes -- the planner's notes and the
// note the guest left with their RSVP, which hold things like diet, health and accessibility --
// are seen only by the owner and Edit collaborators. View and Comment collaborators get the rest
// of the guest list without them, in the app and in the CSV export.
export function canSeeGuestNotes(accessLevel: string | null | undefined): boolean {
  return accessLevel === "OWNER" || accessLevel === "EDIT";
}

// TS-172 (Tom's decision, 2026-10-05): a guest's email address is kept from View and Comment
// collaborators too -- it's the guest's own contact detail, and the RSVP link goes to it.
export function withoutPrivateNotes<T extends { notes?: string | null; rsvpNotes?: string | null; email?: string | null }>(
  guest: T
): T {
  return { ...guest, notes: null, rsvpNotes: null, ...("email" in guest ? { email: null } : {}) };
}

/** The guest as this person may see them. */
export function guestForViewer<T extends { notes?: string | null; rsvpNotes?: string | null; email?: string | null }>(
  guest: T,
  accessLevel: string | null | undefined
): T {
  return canSeeGuestNotes(accessLevel) ? guest : withoutPrivateNotes(guest);
}
