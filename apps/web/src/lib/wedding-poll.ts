import type { WeddingDTO } from "@seatwise/shared";

// TS-235: the wedding page's 4-second check used to take a new copy of the wedding only when the
// person's access changed, so for everyone but the owner (whose own saves update the page) the
// wedding's name, date, venue, side labels and RSVP cutoff stayed as they were when the page opened
// -- "Bride/Groom" after the owner renamed the sides. Now the settings are taken from every check
// whose copy is newer (a higher settingsRevision). The note comes from the server as this person
// may see it (left out for anyone but the owner), so it's taken as it is.

/** The wedding as it should be after a check answered `fresh` (the same object when nothing is newer). */
export function weddingAfterPoll(cur: WeddingDTO | null, fresh: WeddingDTO): WeddingDTO {
  if (!cur || cur.id !== fresh.id) return fresh;
  if (fresh.settingsRevision <= cur.settingsRevision) return cur;
  return {
    ...cur,
    name: fresh.name,
    eventDate: fresh.eventDate,
    venueName: fresh.venueName,
    note: fresh.note,
    sideMixing: fresh.sideMixing,
    sideLabel1: fresh.sideLabel1,
    sideLabel2: fresh.sideLabel2,
    rsvpCutoffDate: fresh.rsvpCutoffDate,
    emailNotificationsEnabled: fresh.emailNotificationsEnabled,
    ownerId: fresh.ownerId,
    settingsRevision: fresh.settingsRevision,
    updatedAt: fresh.updatedAt,
  };
}
