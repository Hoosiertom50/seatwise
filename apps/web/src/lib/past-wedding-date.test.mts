// TS-263: unit tests for the "this date has already passed" question asked before saving a wedding
// date. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { changedWeddingDateQuestion, pastWeddingDateQuestion } from "./past-wedding-date";
import { localTodayIso } from "./display-format";

const today = "2026-10-13";

test("a date before today asks, naming the date as MM-DD-YYYY", () => {
  assert.equal(
    pastWeddingDateQuestion("2025-10-13", today),
    "This date (10-13-2025) has already passed — is that right?"
  );
  // Yesterday is already past.
  assert.equal(
    pastWeddingDateQuestion("2026-10-12", today),
    "This date (10-12-2026) has already passed — is that right?"
  );
});

test("an empty date, today and a later date save straight away", () => {
  assert.equal(pastWeddingDateQuestion("", today), null);
  assert.equal(pastWeddingDateQuestion("2026-10-13", today), null);
  assert.equal(pastWeddingDateQuestion("2026-10-14", today), null);
  assert.equal(pastWeddingDateQuestion("2030-01-01", today), null);
});

test("'today' is the planner's own date -- late evening in the US is not yet tomorrow", () => {
  // 9pm on 13 Oct in New York is already 14 Oct in UTC; a wedding on the 13th is today, not past,
  // and one on the 12th is past. Compared with UTC's date, the 13th would have asked. The zone is
  // set here (PR #114 review): on a UTC test machine a local 9pm is still the 13th in UTC too.
  const savedZone = process.env.TZ;
  process.env.TZ = "America/New_York";
  let localToday: string;
  const lateEvening = new Date(Date.UTC(2026, 9, 14, 1, 0, 0));
  try {
    localToday = localTodayIso(lateEvening);
  } finally {
    if (savedZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedZone;
  }
  assert.equal(lateEvening.toISOString().slice(0, 10), "2026-10-14");
  assert.equal(localToday, "2026-10-13");
  assert.equal(pastWeddingDateQuestion("2026-10-13", localToday), null);
  assert.notEqual(pastWeddingDateQuestion("2026-10-12", localToday), null);
});

test("in Date and venue, only a changed date asks", () => {
  // A wedding whose saved date has passed: saving only a new venue doesn't ask.
  assert.equal(changedWeddingDateQuestion("2025-06-01", "2025-06-01", today), null);
  // Changed to another past date: asks.
  assert.match(changedWeddingDateQuestion("2025-06-02", "2025-06-01", today)!, /^This date \(06-02-2025\)/);
  // Changed from no date to a past one: asks.
  assert.notEqual(changedWeddingDateQuestion("2024-01-01", null, today), null);
  // Cleared, or moved to today or later: saves straight away.
  assert.equal(changedWeddingDateQuestion("", "2027-06-01", today), null);
  assert.equal(changedWeddingDateQuestion("2026-10-13", "2027-06-01", today), null);
  assert.equal(changedWeddingDateQuestion("2027-06-02", "2027-06-01", today), null);
});
