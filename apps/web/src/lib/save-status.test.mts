// TS-166: unit tests for which requests count toward the header's "Saving… / Saved / Not saved".
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tracksSaveStatus } from "./api-client";

test("planner changes count as saves", () => {
  assert.equal(tracksSaveStatus("POST", "/api/v1/weddings/w1/guests"), true);
  assert.equal(tracksSaveStatus("PATCH", "/api/v1/weddings/w1/tables/t1"), true);
  assert.equal(tracksSaveStatus("DELETE", "/api/v1/weddings/w1/guests/g1"), true);
  assert.equal(tracksSaveStatus("POST", "/api/v1/weddings/w1/guests/import/commit"), true);
});

test("reads, sign-in, import previews and marking notifications read don't", () => {
  assert.equal(tracksSaveStatus("GET", "/api/v1/weddings/w1"), false);
  assert.equal(tracksSaveStatus("POST", "/api/v1/auth/login"), false);
  assert.equal(tracksSaveStatus("POST", "/api/v1/weddings/w1/guests/import/preview"), false);
  assert.equal(tracksSaveStatus("POST", "/api/v1/notifications"), false);
  assert.equal(tracksSaveStatus("POST", "/api/v1/notifications/n1/read"), false);
});
