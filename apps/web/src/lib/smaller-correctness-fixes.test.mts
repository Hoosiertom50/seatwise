// TS-214: unit tests for the review-7 smaller correctness fixes -- timeline order across midnight,
// vendor arrivals in the early morning, a copied wedding's name and a reply notification cut
// between whole characters, the guest-list order, the invited/attending counts, the RSVP cutoff
// check, and the plain-dollar limit messages. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareTimelineEntries,
  sameTimelineSlot,
  timelineTimeLabel,
  compareArrivals,
  arrivalTimeLabel,
  shortenWithEllipsis,
} from "../../../../packages/shared/src/timeline-order";
import {
  copiedWeddingName,
  weddingNameField,
  rsvpCutoffWarning,
  updateWeddingSchema,
} from "../../../../packages/shared/src/schemas/wedding";
import { createTimelineEntrySchema, updateTimelineEntrySchema } from "../../../../packages/shared/src/schemas/timeline";
import { createVendorSchema, setBudgetSchema } from "../../../../packages/shared/src/schemas/vendor";
import { formatGuestCounts, attendingPeople } from "../../../../packages/shared/src/guest-counts";
import { FIELD_LIMITS } from "../../../../packages/shared/src/field-limits";
import { compareGuestNames } from "./guest-name-order";

const entry = (time: string, nextDay: boolean, description: string, sortOrder = 0) => ({
  id: description,
  time,
  nextDay,
  description,
  sortOrder,
  createdAt: "2026-10-07T12:00:00.000Z",
});

test("timeline: entries after midnight (next day) come after the wedding day's own, then by time", () => {
  const list = [
    entry("00:30", true, "Last dance"),
    entry("16:00", false, "Ceremony"),
    entry("01:15", true, "Send-off"),
    entry("23:30", false, "Cake"),
    entry("09:00", false, "Hair and makeup"),
  ];
  assert.deepEqual(
    [...list].sort(compareTimelineEntries).map((e) => e.description),
    ["Hair and makeup", "Ceremony", "Cake", "Last dance", "Send-off"]
  );
});

test("timeline: entries at the same time keep their planner-set order (sortOrder)", () => {
  const list = [entry("16:00", false, "B", 1), entry("16:00", false, "A", 0), entry("16:00", true, "C", 0)];
  assert.deepEqual([...list].sort(compareTimelineEntries).map((e) => e.description), ["A", "B", "C"]);
});

test("timeline: 12:30 AM on the wedding day and 12:30 AM the next day aren't the same slot", () => {
  assert.equal(sameTimelineSlot(entry("00:30", false, "a"), entry("00:30", true, "b")), false);
  assert.equal(sameTimelineSlot(entry("00:30", true, "a"), entry("00:30", true, "b")), true);
});

test("timeline: a next-day time is shown as 12:30 AM (next day)", () => {
  assert.equal(timelineTimeLabel("00:30", true), "12:30 AM (next day)");
  assert.equal(timelineTimeLabel("16:30", false), "4:30 PM");
  assert.equal(timelineTimeLabel("12:00"), "12:00 PM");
});

test("timeline: a cleared or 24-hour-looking time is refused with 'Pick a time, like 4:30 PM'", () => {
  for (const time of ["", "25:00", "4:30 PM"]) {
    const parsed = updateTimelineEntrySchema.safeParse({ time });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error!.issues[0].message, "Pick a time, like 4:30 PM");
  }
  const missing = createTimelineEntrySchema.safeParse({ description: "Toast" });
  assert.equal(missing.error!.issues[0].message, "Pick a time, like 4:30 PM");
  assert.equal(createTimelineEntrySchema.safeParse({ time: "00:30", nextDay: true, description: "Last dance" }).success, true);
});

test("vendor arrivals: before 5:00 AM is the early morning after the wedding -- listed after the day's arrivals", () => {
  const vendors = [
    { name: "Shuttle pick-up", arrivalTime: "01:30" },
    { name: "Florist", arrivalTime: "10:00" },
    { name: "Not set", arrivalTime: null },
    { name: "Caterer", arrivalTime: "08:00" },
    { name: "Hair", arrivalTime: "05:00" },
  ];
  assert.deepEqual(
    [...vendors].sort(compareArrivals).map((v) => v.name),
    ["Hair", "Caterer", "Florist", "Shuttle pick-up", "Not set"]
  );
  assert.equal(arrivalTimeLabel("01:30"), "1:30 AM (next day)");
  assert.equal(arrivalTimeLabel("05:00"), "5:00 AM");
});

test("copy name: a long name of non-basic-plane letters is cut between whole characters and stays a valid name", () => {
  const original = "𝔄".repeat(100); // 100 characters, 200 UTF-16 units -- the length limit
  assert.equal(original.length, FIELD_LIMITS.weddingName);
  const copy = copiedWeddingName(original);
  assert.ok(copy.endsWith(" - copy"));
  assert.ok(copy.length <= FIELD_LIMITS.weddingName);
  assert.ok(!copy.includes("�"));
  // No lone half of a character is left over.
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(copy));
  assert.equal([...copy.replace(" - copy", "")].every((ch) => ch === "𝔄"), true);
  assert.equal(copiedWeddingName("Alex & Jordan"), "Alex & Jordan - copy");
  assert.equal(weddingNameField.safeParse(copiedWeddingName("A".repeat(200))).success, true);
});

test("reply notification: cut between whole characters with '…', never ending in half an emoji", () => {
  const body = `${"a".repeat(119)}🎉 and more`;
  const cut = shortenWithEllipsis(body, 120);
  assert.equal(cut, `${"a".repeat(119)}…`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut));
  assert.equal(shortenWithEllipsis("Short reply", 120), "Short reply");
  assert.equal(shortenWithEllipsis("x".repeat(120), 120), "x".repeat(120));
  assert.ok(shortenWithEllipsis("x".repeat(121), 120).length <= 120);
});

test("guest order: last name, then first name, then id -- the server's order", () => {
  const guests = [
    { id: "3", firstName: "Zed", lastName: "Smith" },
    { id: "2", firstName: "Amy", lastName: "Smith" },
    { id: "1", firstName: "Amy", lastName: "Smith" },
    { id: "4", firstName: "Bo", lastName: "Lee" },
  ];
  assert.deepEqual(
    [...guests].sort(compareGuestNames).map((g) => `${g.firstName} ${g.lastName} ${g.id}`),
    ["Bo Lee 4", "Amy Smith 1", "Amy Smith 2", "Zed Smith 3"]
  );
});

test("people counts: invited counts everyone, attending only guests marked Attending (as the Tables tab)", () => {
  const guests = [
    { headcount: 2, dayOfAttendance: "ATTENDING" },
    { headcount: 3, dayOfAttendance: "NOT_ATTENDING" }, // declined
    { headcount: 1, dayOfAttendance: "ATTENDING" },
  ];
  assert.equal(attendingPeople(guests), 3);
  assert.equal(formatGuestCounts(3, 6, attendingPeople(guests)), "3 invitations · 6 people invited · 3 attending");
  assert.equal(formatGuestCounts(1, 1, 0), "1 invitation · 1 person invited · 0 attending");
});

test("RSVP cutoff: before today or after the wedding asks first; today, or between, doesn't", () => {
  const today = "2026-10-07";
  assert.match(rsvpCutoffWarning("2025-10-01", today, "2026-11-01")!, /before today/);
  assert.match(rsvpCutoffWarning("2026-12-01", today, "2026-11-01")!, /after the wedding date/);
  assert.equal(rsvpCutoffWarning("2026-10-07", today, "2026-11-01"), null);
  assert.equal(rsvpCutoffWarning("2026-11-01", today, "2026-11-01"), null);
  assert.equal(rsvpCutoffWarning("2030-06-01", today, null), null);
  assert.equal(rsvpCutoffWarning("", today, null), null);
});

test("wedding settings take the revision they're based on", () => {
  assert.equal(updateWeddingSchema.safeParse({ venueName: "The Barn", expectedRevision: 3 }).success, true);
  assert.equal(updateWeddingSchema.safeParse({ venueName: "The Barn", expectedRevision: -1 }).success, false);
});

test("money limits are said in plain dollars, never cents", () => {
  const cost = createVendorSchema.safeParse({ name: "Band", category: "MUSIC_ENTERTAINMENT", costCents: 100_000_001 });
  assert.equal(cost.error!.issues[0].message, "A vendor's cost can be at most $1,000,000.00.");
  const budget = setBudgetSchema.safeParse({ budgetCents: 1_000_000_001 });
  assert.equal(budget.error!.issues[0].message, "The budget can be at most $10,000,000.00.");
  assert.equal(setBudgetSchema.safeParse({ budgetCents: 1_000_000_000 }).success, true);
  assert.doesNotMatch(budget.error!.issues[0].message, /\d{5,}/);
});

// TS-214 (Copilot review on PR #102): a wedding-settings save must say which version it's based on
// -- without it, it used to skip the "changed since you opened them" check altogether.
test("a wedding-settings save without the version it's based on is refused", () => {
  assert.equal(updateWeddingSchema.safeParse({ venueName: "The Old Barn" }).success, false);
  assert.equal(updateWeddingSchema.safeParse({ venueName: "The Old Barn", expectedRevision: 3 }).success, true);
});
