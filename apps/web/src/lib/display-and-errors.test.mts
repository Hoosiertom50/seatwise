// TS-151: unit tests for the date helpers and the "say which field" error message. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, formatDateTime, formatMomentDate, localTodayIso } from "./display-format";
import { ApiError, apiErrorMessage } from "./api-client";

test("a wedding date shows as that same date, MM-DD-YYYY, whatever the time zone", () => {
  process.env.TZ = "America/Los_Angeles";
  // TS-177 (Tom): every date is MM-DD-YYYY.
  assert.equal(formatDate("2027-06-12"), "06-12-2027");
  assert.equal(formatDate("2026-01-05"), "01-05-2026");
});

test("a moment shows as MM-DD-YYYY with a 12-hour time and AM/PM, never 24-hour time", () => {
  assert.equal(formatDateTime(new Date(2026, 9, 5, 17, 12, 15)), "10-05-2026, 5:12 PM");
  assert.equal(formatDateTime(new Date(2026, 0, 9, 0, 5)), "01-09-2026, 12:05 AM");
  assert.equal(formatDateTime(new Date(2026, 0, 9, 12, 0)), "01-09-2026, 12:00 PM");
  assert.equal(formatMomentDate(new Date(2026, 9, 5, 23, 59)), "10-05-2026");
});

test("today is the planner's own date, not UTC's", () => {
  // 9pm on 1 Oct in Chicago is already 2 Oct in UTC.
  const lateEvening = new Date(2026, 9, 1, 21, 0, 0);
  assert.equal(localTodayIso(lateEvening), "2026-10-01");
});

test("a 422 says which field was refused instead of 'Validation failed'", () => {
  const err = new ApiError("Validation failed", 422, { contactEmail: ["Not a valid email address"] });
  assert.equal(apiErrorMessage(err, [], "fallback"), "Not a valid email address");
  assert.equal(apiErrorMessage(err, ["contactEmail"], "fallback"), "Not a valid email address");
  assert.equal(apiErrorMessage(new ApiError("Taken", 409), [], "fallback"), "Taken");
  assert.equal(apiErrorMessage(new Error("x"), [], "fallback"), "fallback");
});
