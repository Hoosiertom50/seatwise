// TS-151: unit tests for the date helpers and the "say which field" error message. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatShortEventDate, localTodayIso } from "./display-format";
import { ApiError, apiErrorMessage } from "./api-client";

test("a wedding date shows as that same date whatever the time zone", () => {
  process.env.TZ = "America/Los_Angeles";
  assert.equal(formatShortEventDate("2027-06-12").includes("12"), true);
  assert.equal(formatShortEventDate("2027-06-12").includes("11"), false);
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
