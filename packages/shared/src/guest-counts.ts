// TS-177 (Tom's decision): a guest-list count means two things -- invitations (guest records, each
// a household or a single person) and people (everyone they bring, i.e. the sum of headcounts).
// The dashboard showed one and the Guests tab the other under the same word, so the same wedding
// had two different "guest" counts. Both places now show both, the same way.
// TS-214: "people" counted everyone invited, declined and not-attending guests included, while the
// Tables tab's "Attending" left them out -- so the two numbers disagreed with no word why. It now
// says "invited", and (where it's known) how many of them are attending, the same count as Tables.
export function formatGuestCounts(invitations: number, people: number, attending?: number): string {
  const base = `${invitations} invitation${invitations === 1 ? "" : "s"} · ${people} ${people === 1 ? "person" : "people"} invited`;
  return attending === undefined ? base : `${base} · ${attending} attending`;
}

/** TS-214: everyone coming, as the Tables tab counts them -- the headcounts of guests marked Attending. */
export function attendingPeople(guests: { headcount: number; dayOfAttendance: string }[]): number {
  return guests.reduce((sum, g) => sum + (g.dayOfAttendance === "ATTENDING" ? g.headcount : 0), 0);
}

/**
 * TS-198: the plus-ones to print with a guest on the door lookup list and the place cards -- only
 * when their party is bigger than one. A guest whose party went back to just themselves keeps the
 * old names on their record, and printing them used to put people at the door who aren't coming.
 */
export function plusOnesToPrint(guest: { headcount: number; plusOneNames: string | null }): string | null {
  return guest.headcount > 1 && guest.plusOneNames?.trim() ? guest.plusOneNames : null;
}
