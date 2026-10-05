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

// TS-170: a request that never answers gives up (as a connection error) instead of hanging forever.
test("a request with no answer gives up after the time limit", async () => {
  const { fetchWithRetry, NETWORK_ERROR_STATUS } = await import("./api-client");
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  // Node 22 doesn't let the time limit's own timer keep the test process alive -- this does.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const started = Date.now();
    await assert.rejects(fetchWithRetry("/api/v1/x", { method: "POST" }, 50), (err: { status?: number }) => err.status === NETWORK_ERROR_STATUS);
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = realFetch;
  }
});
