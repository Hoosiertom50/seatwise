// TS-235: the Tables tab's "Assigned" figure and each table's "X/Y seated", worked out at render
// time from the current plan's seats and the live guest list. Before, the counts were worked out
// once, when the tab opened, and went stale while "Attending" (from the live guest list) moved on.

export interface SeatForCount {
  guestId: string;
  tableId: string;
  /** TS-221: a seat held by a guest since marked not attending (older versions only). */
  notAttending?: boolean;
}

export interface GuestForCount {
  id: string;
  headcount: number;
  dayOfAttendance: string;
}

/**
 * Seated headcount per table. Only tables still in `tableIds` count (a removed table drops out at
 * once), only guests still on the list count, and a guest marked not attending counts nowhere --
 * the same people the "Attending" figure leaves out.
 */
export function seatedHeadcountByTable(
  seats: readonly SeatForCount[],
  guests: readonly GuestForCount[],
  tableIds: Iterable<string>
): Record<string, number> {
  const tables = new Set(tableIds);
  const byId = new Map(guests.map((g) => [g.id, g]));
  const counts: Record<string, number> = {};
  for (const seat of seats) {
    if (seat.notAttending || !tables.has(seat.tableId)) continue;
    const guest = byId.get(seat.guestId);
    if (!guest || guest.dayOfAttendance === "NOT_ATTENDING") continue;
    counts[seat.tableId] = (counts[seat.tableId] ?? 0) + guest.headcount;
  }
  return counts;
}

/** True when two seat lists are the same (so a poll that found nothing new doesn't redraw). */
export function sameSeats(a: readonly SeatForCount[], b: readonly SeatForCount[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.guestId === b[i].guestId && s.tableId === b[i].tableId && !!s.notAttending === !!b[i].notAttending);
}
