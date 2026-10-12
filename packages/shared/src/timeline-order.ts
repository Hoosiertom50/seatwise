import { cutToLimit } from "./field-limits";

// TS-214: a run-of-show often goes past midnight ("12:30 AM Last dance"). Times are kept as plain
// "HH:MM" text, so on their own "00:30" sorted before "16:00 Ceremony". A timeline entry now has a
// "next day" flag (the planner ticks "After midnight (next day)"), and every list puts next-day
// entries after the wedding day's own: (nextDay, time, sortOrder, createdAt, id).

export interface TimelineOrderParts {
  time: string;
  nextDay?: boolean;
  sortOrder?: number;
  createdAt?: string | Date;
  id?: string;
}

function plainCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The one order timeline entries are listed in (the database's ORDER BY matches it). */
export function compareTimelineEntries(a: TimelineOrderParts, b: TimelineOrderParts): number {
  return (
    Number(!!a.nextDay) - Number(!!b.nextDay) ||
    plainCompare(a.time, b.time) ||
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
    new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime() ||
    plainCompare(a.id ?? "", b.id ?? "")
  );
}

/** Whether two entries sit at the same moment (same time on the same day) -- reorder works within one. */
export function sameTimelineSlot(a: TimelineOrderParts, b: TimelineOrderParts): boolean {
  return a.time === b.time && !!a.nextDay === !!b.nextDay;
}

/** "16:30" -> "4:30 PM". */
export function clockTime12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/** "00:30" with the next-day flag -> "12:30 AM (next day)". */
export function timelineTimeLabel(time: string, nextDay?: boolean): string {
  return `${clockTime12(time)}${nextDay ? " (next day)" : ""}`;
}

// TS-214: a vendor's arrival time has no next-day flag (it's one time per vendor, usually hours
// before the ceremony). Arrivals before this cut-off are taken as the early hours after the
// wedding day -- a late pick-up or tear-down crew -- so they're listed after the day's arrivals
// and shown with "(next day)". Nobody sets up for a wedding before 5:00 AM.
export const ARRIVAL_NEXT_DAY_BEFORE = "05:00";

export function arrivalIsNextDay(time: string): boolean {
  return time < ARRIVAL_NEXT_DAY_BEFORE;
}

/** Vendors by arrival: the wedding day's arrivals, then early-morning ones, then those not set; then name. */
export function compareArrivals(
  a: { arrivalTime: string | null; name: string },
  b: { arrivalTime: string | null; name: string }
): number {
  const rank = (t: string | null) => (t === null ? 2 : arrivalIsNextDay(t) ? 1 : 0);
  return (
    rank(a.arrivalTime) - rank(b.arrivalTime) ||
    plainCompare(a.arrivalTime ?? "", b.arrivalTime ?? "") ||
    a.name.localeCompare(b.name)
  );
}

/** "02:00" -> "2:00 AM (next day)"; "15:00" -> "3:00 PM". */
export function arrivalTimeLabel(time: string): string {
  return timelineTimeLabel(time, arrivalIsNextDay(time));
}

/**
 * TS-214: `text` cut to at most `max` characters, ending in "…" when anything was cut -- never in
 * the middle of an emoji (see cutToLimit).
 */
export function shortenWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${cutToLimit(text, max - 1).trimEnd()}…`;
}
