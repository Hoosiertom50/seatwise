// TS-194: unit tests for how the site-wide email counts roll over the last 24 hours
// (rollingTotal in packages/db/src/queries/rate-limit.ts). Run with `pnpm --filter @seatwise/web test`.
// Pure arithmetic -- no database.
import { test } from "node:test";
import assert from "node:assert/strict";

const { rollingTotal, ROLLING_BUCKET_SECONDS, ROLLING_SPAN_SECONDS } = await import("@seatwise/db");

const HOUR = 3_600_000;
const NOW_START = Date.UTC(2026, 9, 6, 1); // 1:00 AM UTC -- just after midnight

test("the windows are an hour each, over 24 hours", () => {
  assert.equal(ROLLING_BUCKET_SECONDS, 3600);
  assert.equal(ROLLING_SPAN_SECONDS, 86_400);
});

test("emails sent in the hours before -- even before midnight -- still count", () => {
  const earlier = [
    { startMs: NOW_START - 1 * HOUR, count: 100 }, // midnight to 1 AM
    { startMs: NOW_START - 2 * HOUR, count: 80 }, // 11 PM the day before
    { startMs: NOW_START - 23 * HOUR, count: 10 },
  ];
  assert.equal(rollingTotal(5, earlier, NOW_START), 195);
});

test("the window 24 hours back still counts (never less than 24 hours); anything older doesn't", () => {
  const earlier = [
    { startMs: NOW_START - 24 * HOUR, count: 7 },
    { startMs: NOW_START - 25 * HOUR, count: 1000 },
  ];
  assert.equal(rollingTotal(1, earlier, NOW_START), 8);
});

test("a row for the current window itself isn't counted twice", () => {
  assert.equal(rollingTotal(3, [{ startMs: NOW_START, count: 3 }], NOW_START), 3);
});

test("counts read back as text from the database are added as numbers", () => {
  assert.equal(rollingTotal(1, [{ startMs: NOW_START - HOUR, count: "4" as unknown as number }], NOW_START), 5);
});
