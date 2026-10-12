/**
 * TS-177 (Tom, 2026-10-06): how the app shows dates and times -- "MM-DD-YYYY" for a date, and
 * "MM-DD-YYYY, h:mm AM/PM" for a moment, in the viewer's own time zone (never 24-hour time). The
 * same rule as apps/web/src/lib/display-format.ts, kept here so tests state what they expect.
 */
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "2027-06-12" -> "06-12-2027". */
export function shownDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${m}-${d}-${y}`;
}

/** A timestamp -> "10-05-2026, 5:12 PM". */
export function shownDateTime(moment: string | Date): string {
  const t = typeof moment === "string" ? new Date(moment) : moment;
  const h = t.getHours();
  return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}-${t.getFullYear()}, ${h % 12 === 0 ? 12 : h % 12}:${pad2(t.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
