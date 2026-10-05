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

/** "2027-06-12" -> "Saturday, June 12, 2027" (read as a calendar date, never shifted by time zone). */
export function formatEventDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// TS-151: a wedding date ("YYYY-MM-DD") in the short local style, e.g. "6/12/2027". Reading the
// string with new Date() treats it as midnight UTC, which is the evening before anywhere in the
// Americas -- the date showed a day early on the dashboard and wedding page.
export function formatShortEventDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { timeZone: "UTC" });
}

// TS-151: today's date where the planner is, as "YYYY-MM-DD" (toISOString() gives UTC's date,
// which is already tomorrow on a US evening).
export function localTodayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
