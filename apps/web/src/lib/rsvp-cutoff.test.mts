// TS-153: unit tests for when RSVPs close. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRsvpCutoffPast } from "../../../../packages/shared/src/rsvp-cutoff";

test("no cutoff never closes", () => {
  assert.equal(isRsvpCutoffPast(null, new Date("2030-01-01T00:00:00Z")), false);
});

test("a US guest can still answer on the evening of the cutoff day", () => {
  // 9pm in Los Angeles on 15 June is already 04:00 UTC on 16 June.
  assert.equal(isRsvpCutoffPast("2027-06-15", new Date("2027-06-16T04:00:00Z")), false);
  // ...and late that night in Hawaii (UTC-10), 23:30 there is 09:30 UTC on the 16th.
  assert.equal(isRsvpCutoffPast("2027-06-15", new Date("2027-06-16T09:30:00Z")), false);
});

test("it closes once the cutoff day has ended everywhere", () => {
  assert.equal(isRsvpCutoffPast("2027-06-15", new Date("2027-06-16T12:00:00Z")), true);
  assert.equal(isRsvpCutoffPast("2027-06-15", new Date("2027-06-20T00:00:00Z")), true);
});
