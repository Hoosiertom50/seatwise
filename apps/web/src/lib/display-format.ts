import type { VendorCategory } from "@seatwise/shared";

// TS-114: shared display helpers for pages outside the wedding tabs (the vendor's read-only page).
// Same labels and 12-hour format the Budget and Timeline tabs show.

export const VENDOR_CATEGORY_LABELS: Record<VendorCategory, string> = {
  CATERING: "Catering",
  VENUE: "Venue",
  FLORIST: "Florist",
  PHOTOGRAPHY: "Photography",
  VIDEOGRAPHY: "Videography",
  MUSIC_ENTERTAINMENT: "Music / Entertainment",
  ATTIRE: "Attire",
  CAKE_BAKERY: "Cake / Bakery",
  RENTALS: "Rentals",
  TRANSPORTATION: "Transportation",
  STATIONERY: "Stationery",
  OTHER: "Other",
};

export function vendorCategoryLabel(category: VendorCategory, categoryOther: string | null): string {
  return category === "OTHER" && categoryOther ? categoryOther : VENDOR_CATEGORY_LABELS[category];
}

/** "14:30" -> "2:30 PM". */
export function formatClockTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// TS-177 (Tom, 2026-10-06): every date anywhere -- screens, emails, messages -- is shown as
// MM-DD-YYYY. Use these two helpers; never toLocaleDateString / toLocaleString directly.
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A calendar date ("YYYY-MM-DD", e.g. a wedding date or RSVP cutoff) as "MM-DD-YYYY". Read as the
 * date it is, never through a time zone (TS-151: going through Date made it a day early in the US).
 */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${m}-${d}-${y}`;
}

/** A moment (a timestamp) as "MM-DD-YYYY, h:mm AM/PM" in the viewer's own time zone. */
export function formatDateTime(moment: string | Date): string {
  const t = typeof moment === "string" ? new Date(moment) : moment;
  const date = `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}-${t.getFullYear()}`;
  return `${date}, ${formatClockTime(`${pad2(t.getHours())}:${pad2(t.getMinutes())}`)}`;
}

/** A moment as just its date, "MM-DD-YYYY", in the viewer's own time zone. */
export function formatMomentDate(moment: string | Date): string {
  const t = typeof moment === "string" ? new Date(moment) : moment;
  return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}-${t.getFullYear()}`;
}

// TS-151: today's date where the planner is, as "YYYY-MM-DD" (toISOString() gives UTC's date,
// which is already tomorrow on a US evening).
export function localTodayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
