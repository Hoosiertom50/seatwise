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

// TS-175: a delete whose first try got no answer, retried and told "not found", did happen.
// TS-209: so does a first try told the item itself is gone (someone else deleted it a moment
// earlier) -- but not a 404 about the wedding, which is a real answer.
test("a delete that finds the item already gone counts as deleted; a 404 about the wedding is still an error", async () => {
  const { api, ApiError } = await import("./api-client");
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("connection dropped");
      return new Response(JSON.stringify({ error: "Guest not found" }), { status: 404 });
    }) as typeof fetch;
    assert.deepEqual(await api.delete("/api/v1/weddings/w1/guests/g1"), {});
    assert.equal(calls, 2);

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Guest not found" }), { status: 404 })) as typeof fetch;
    assert.deepEqual(await api.delete("/api/v1/weddings/w1/guests/g1"), {});

    for (const error of ["Wedding not found", "This wedding was deleted — nothing was saved."]) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ error }), { status: 404 })) as typeof fetch;
      await assert.rejects(api.delete("/api/v1/weddings/w1/guests/g1"), (err) => err instanceof ApiError && err.status === 404);
    }
    // Other methods are unchanged: a 404 on an edit is still an error.
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Guest not found" }), { status: 404 })) as typeof fetch;
    await assert.rejects(api.patch("/api/v1/weddings/w1/guests/g1", { notes: "x" }), (err) => err instanceof ApiError && err.status === 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// TS-186: deleting one's own account, retried after a lost answer, finds nobody signed in -- it worked.
test("a retried account deletion told 'not signed in' counts as deleted; a first-try 401 is still an error", async () => {
  const { api, ApiError } = await import("./api-client");
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("connection dropped");
      return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
    }) as typeof fetch;
    assert.deepEqual(await api.delete("/api/v1/auth/me", { password: "x" }), {});
    // TS-199: the third call is the check that nobody is signed in any more.
    assert.equal(calls, 3);

    // TS-199: still signed in when checked (e.g. the retry's 401 was a wrong password) -- not deleted.
    calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) throw new Error("connection dropped");
      if (init?.method === "GET") return new Response(JSON.stringify({ user: { id: "u1" } }), { status: 200 });
      return new Response(JSON.stringify({ error: "Wrong password" }), { status: 401 });
    }) as typeof fetch;
    await assert.rejects(api.delete("/api/v1/auth/me", { password: "x" }), (err) => err instanceof ApiError && err.status === 401);
    assert.equal(calls, 3);

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 })) as typeof fetch;
    await assert.rejects(api.delete("/api/v1/auth/me", { password: "x" }), (err) => err instanceof ApiError && err.status === 401);
    // Only for the account itself: elsewhere a retried 401 is still a lost session.
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("connection dropped");
      return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
    }) as typeof fetch;
    await assert.rejects(api.delete("/api/v1/weddings/w1/guests/g1"), (err) => err instanceof ApiError && err.status === 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// TS-177: an edit whose first try got no answer, retried and told "changed since you loaded it",
// did save if the fresh record already has every value that was sent.
test("a retried edit refused only because its first try landed counts as saved", async () => {
  const { api } = await import("./api-client");
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    const fresh = { id: "g1", firstName: "Ada", lastName: "Lovelace", revision: 4 };
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("connection dropped");
      return new Response(JSON.stringify({ error: "This guest changed since you loaded it", guest: fresh }), { status: 409 });
    }) as typeof fetch;
    const result = await api.patch<{ guest: typeof fresh; warnings: string[] }>("/api/v1/weddings/w1/guests/g1", {
      firstName: "Ada",
      expectedRevision: 3,
    });
    assert.equal(calls, 2);
    assert.deepEqual(result.guest, fresh);
    assert.deepEqual(result.warnings, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a retried edit whose values aren't in the fresh record is still a conflict", async () => {
  const { api, ApiError } = await import("./api-client");
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("connection dropped");
      return new Response(
        JSON.stringify({ error: "This table changed since you loaded it", table: { id: "t1", capacity: 10, revision: 5 } }),
        { status: 409 }
      );
    }) as typeof fetch;
    await assert.rejects(
      api.patch("/api/v1/weddings/w1/tables/t1", { capacity: 8, expectedRevision: 4 }),
      (err) => err instanceof ApiError && err.status === 409 && (err.data?.table as { capacity: number }).capacity === 10
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a first-try conflict is never treated as saved, even when the values match", async () => {
  const { api, ApiError } = await import("./api-client");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "changed", vendor: { id: "v1", name: "Blooms", revision: 2 } }), { status: 409 })) as typeof fetch;
    await assert.rejects(
      api.patch("/api/v1/weddings/w1/vendors/v1", { name: "Blooms", expectedRevision: 1 }),
      (err) => err instanceof ApiError && err.status === 409
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("resolveRetriedPatchConflict answers in each route's own shape, and only for known routes", async () => {
  const { resolveRetriedPatchConflict } = await import("./api-client");
  const body = (o: object) => JSON.stringify(o);
  assert.deepEqual(
    resolveRetriedPatchConflict("/api/v1/weddings/w1/plan-versions/p1", body({ label: "Final", expectedRevision: 2 }), {
      planVersion: { id: "p1", label: "Final" },
    }),
    { planVersion: { id: "p1", label: "Final" } }
  );
  assert.deepEqual(
    resolveRetriedPatchConflict("/api/v1/weddings/w1/budget", body({ budgetCents: 5000, expectedRevision: 1 }), {
      summary: { budgetCents: 5000, totalCostCents: 0, remainingCents: 5000, budgetRevision: 2 },
    }),
    { summary: { budgetCents: 5000, totalCostCents: 0, remainingCents: 5000, budgetRevision: 2 } }
  );
  assert.deepEqual(
    resolveRetriedPatchConflict("/api/v1/weddings/w1/timeline-entries/e1", body({ title: "Toasts", expectedRevision: 1 }), {
      entry: { id: "e1", title: "Toasts" },
    }),
    { entry: { id: "e1", title: "Toasts" } }
  );
  // A field the fresh record doesn't carry can't be confirmed, so it stays a conflict.
  assert.equal(
    resolveRetriedPatchConflict("/api/v1/weddings/w1/tables/t1", body({ requiredGuestIds: ["g1"], expectedRevision: 1 }), {
      table: { id: "t1" },
    }),
    null
  );
  // A route with no fresh record in its 409 (a plan's seats) is never auto-resolved.
  assert.equal(
    resolveRetriedPatchConflict("/api/v1/weddings/w1/plan-versions/p1/assignments", body({ x: 1 }), { planVersion: { x: 1 } }),
    null
  );
});

// TS-182: generating a plan and committing an import may honestly take longer than other requests.
test("generate and import commit get the long timeout; everything else the usual one", async () => {
  const { requestTimeoutFor, REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS } = await import("./api-client");
  assert.equal(requestTimeoutFor("POST", "/api/v1/weddings/w1/plan-versions/generate"), LONG_REQUEST_TIMEOUT_MS);
  assert.equal(requestTimeoutFor("POST", "/api/v1/weddings/w1/guests/import/commit"), LONG_REQUEST_TIMEOUT_MS);
  assert.equal(requestTimeoutFor("POST", "/api/v1/weddings/w1/guests/import/preview"), REQUEST_TIMEOUT_MS);
  assert.equal(requestTimeoutFor("GET", "/api/v1/weddings/w1/plan-versions"), REQUEST_TIMEOUT_MS);
  assert.ok(LONG_REQUEST_TIMEOUT_MS >= 120_000);
});
