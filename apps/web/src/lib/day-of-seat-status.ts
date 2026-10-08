// TS-250: the line under each guest's name on the Day-of tab. A guest flagged "Needs reassignment"
// (their table stopped working for them after the plan was approved -- a party grew, a table got
// smaller, a new must-not rule...) used to read "Seated at Table 3", as if all was well.

export interface DayOfSeat {
  tableLabel: string;
  needsReassignment: boolean;
}

export function dayOfSeatStatus(notAttending: boolean, seat: DayOfSeat | undefined): string {
  if (notAttending) return "Not attending";
  if (!seat) return "Unassigned";
  return seat.needsReassignment ? `Needs reassignment (at ${seat.tableLabel})` : `Seated at ${seat.tableLabel}`;
}

/** TS-250: a guest's table in the swap lists -- "Table 3", or "Table 3, needs a new seat". */
export function dayOfSwapTableText(seat: DayOfSeat): string {
  return seat.needsReassignment ? `${seat.tableLabel}, needs a new seat` : seat.tableLabel;
}
