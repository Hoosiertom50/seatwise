// TS-220: unit tests for review 8's "false results" fixes -- revoking an invite the person just
// accepted is refused (not "already revoked"), saved changes whose read-back fails are never
// answered as errors (timeline reorder, attendance, RSVP link, guest email), and a retried delete
// counts as "already gone" only when it's the item that's gone. The database is replaced by a
// scripted stand-in that records each statement, and `fetch` by a stand-in, so nothing real is
// needed. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { pool, revokeInvite, InviteError, INVITE_ALREADY_ACCEPTED_MESSAGE, reorderTimelineEntry, setGuestAttendance } =
  await import("@seatwise/db");
const { api, ApiError } = await import("./api-client");
const { rsvpLinkAfterFailure, rsvpEmailChange } = await import("./after-commit-answers");

type Rows = Record<string, unknown>[];
type Responder = (sql: string, params: unknown[]) => Rows | undefined;

const log: string[] = [];
const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);
const realFetch = globalThis.fetch;

function fakeDatabase(respond: Responder) {
  log.length = 0;
  const run = async (sql: string, params: unknown[] = []) => {
    log.push(sql.replace(/\s+/g, " ").trim());
    const rows = respond(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
}

afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
  globalThis.fetch = realFetch;
});

// ---- 1. Revoking an invite the person has just accepted ----

function inviteDatabase(status: string) {
  fakeDatabase((sql) => {
    if (/^\s*UPDATE "wedding_invites" SET status = 'REVOKED'/.test(sql)) return [];
    if (/FROM "weddings" WHERE id = \$1 AND "ownerId" = \$2/.test(sql)) return [{ "?column?": 1 }];
    if (/SELECT status FROM "wedding_invites"/.test(sql)) return [{ status }];
    return [];
  });
}

test("TS-220: revoking an invite that was accepted a moment ago says so (it used to count as revoked)", async () => {
  inviteDatabase("ACCEPTED");
  await assert.rejects(revokeInvite("w1", "i1", "owner"), (err: unknown) => {
    assert.ok(err instanceof InviteError);
    assert.equal(err.code, "ACCEPTED");
    assert.equal(err.message, "They accepted this invite a moment ago — remove them from Collaborators if needed.");
    assert.equal(err.message, INVITE_ALREADY_ACCEPTED_MESSAGE);
    return true;
  });
});

test("TS-220: an invite already revoked or expired is still 'not found' (the page counts it as gone)", async () => {
  for (const status of ["REVOKED", "EXPIRED"]) {
    inviteDatabase(status);
    await assert.rejects(revokeInvite("w1", "i1", "owner"), (err: unknown) => err instanceof InviteError && err.code === "NOT_FOUND");
  }
});

// ---- 2. Saved changes whose read-back fails ----

test("TS-220: a timeline reorder reads the entry back before COMMIT, never after it", async () => {
  const entry = { id: "e1", weddingId: "w1", time: "17:00", nextDay: false, description: "Toast", sortOrder: 0, revision: 2 };
  fakeDatabase((sql) => {
    if (/SELECT time, "nextDay" FROM "timeline_entries"/.test(sql)) return [{ time: "17:00", nextDay: false }];
    if (/FOR NO KEY UPDATE/.test(sql)) return [
      { id: "e0", sortOrder: 0 },
      { id: "e1", sortOrder: 1 },
    ];
    if (/^\s*SELECT id, "weddingId", time/.test(sql)) return [entry];
    return [];
  });
  const saved = await reorderTimelineEntry("e1", "w1", "UP");
  assert.deepEqual(saved, entry);
  const commitAt = log.indexOf("COMMIT");
  const readAt = log.findIndex((s) => s.startsWith('SELECT id, "weddingId", time'));
  assert.ok(commitAt > 0 && readAt > 0 && readAt < commitAt, `read-back at ${readAt}, COMMIT at ${commitAt}`);
  assert.equal(log.length - 1, commitAt, "nothing is read after COMMIT");
});

function attendanceDatabase(planStatus: string) {
  fakeDatabase((sql) => {
    if (/SELECT id, \("firstName" \|\| ' ' \|\| "lastName"\) AS name, "dayOfAttendance"/.test(sql))
      return [{ id: "g1", name: "Ann Lee", dayOfAttendance: "ATTENDING" }];
    if (/SELECT id FROM "plan_versions" WHERE "weddingId" = \$1 AND "isCurrent"/.test(sql)) return [{ id: "p1" }];
    if (/SELECT "dayOfAttendance" FROM "guests" WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return [{ dayOfAttendance: "ATTENDING" }];
    if (/SELECT status FROM "plan_versions" WHERE id = \$1/.test(sql)) return [{ status: planStatus }];
    if (/AS "unassignedCount"/.test(sql)) return [{ unassignedCount: 0, needsReassignmentCount: 0 }];
    // The plan's read-back after the commit fails.
    if (/FROM "plan_versions" pv/.test(sql)) throw new Error("connection lost");
    return [];
  });
}

test("TS-220: attendance saved but the plan not read back -- the route is told, and the approved-plan notice still goes", async () => {
  attendanceDatabase("APPROVED");
  let notRefreshed = false;
  const detail = await setGuestAttendance("w1", "g1", "NOT_ATTENDING", "u1", { onPlanNotRefreshed: () => (notRefreshed = true) });
  assert.equal(detail, null);
  assert.equal(notRefreshed, true);
  const readBackAt = log.findIndex((s) => s.includes('FROM "plan_versions" pv'));
  // Something is asked after the failed read-back: the notification's own queries (before, it was skipped).
  assert.ok(readBackAt > 0 && log.length > readBackAt + 1, "the notification was attempted");
});

test("TS-220: attendance on a plan that isn't approved sends no notice, even when the read-back fails", async () => {
  attendanceDatabase("DRAFT");
  let notRefreshed = false;
  await setGuestAttendance("w1", "g1", "NOT_ATTENDING", "u1", { onPlanNotRefreshed: () => (notRefreshed = true) });
  assert.equal(notRefreshed, true);
  const readBackAt = log.findIndex((s) => s.includes('FROM "plan_versions" pv'));
  assert.equal(log.length - 1, readBackAt, "nothing after the read-back");
});

test("TS-220: 'New link' whose email part failed after the link was made still answers the new link", async () => {
  const link = await rsvpLinkAfterFailure({
    regenerate: true,
    previousToken: "old",
    readToken: async () => "new",
    appUrl: () => "https://seatwise.example",
    hasEmail: true,
  });
  assert.deepEqual(link, { url: "https://seatwise.example/rsvp/new", emailed: false, emailFailed: true });
});

test("TS-220: 'New link' that failed before the link changed is still an error (nothing was saved)", async () => {
  const link = await rsvpLinkAfterFailure({
    regenerate: true,
    previousToken: "old",
    readToken: async () => "old",
    appUrl: () => "https://seatwise.example",
    hasEmail: true,
  });
  assert.equal(link, null);
});

test("TS-220: 'RSVP link' answers the guest's link when only the email part failed; no link or no APP_URL stays an error", async () => {
  const ok = await rsvpLinkAfterFailure({
    regenerate: false,
    previousToken: null,
    readToken: async () => "tok",
    appUrl: () => "https://seatwise.example",
    hasEmail: false,
  });
  assert.deepEqual(ok, { url: "https://seatwise.example/rsvp/tok", emailed: false, emailFailed: false });
  const unreadable = await rsvpLinkAfterFailure({
    regenerate: false,
    previousToken: null,
    readToken: async () => {
      throw new Error("connection lost");
    },
    appUrl: () => "https://seatwise.example",
    hasEmail: true,
  });
  assert.equal(unreadable, null);
  const noAppUrl = await rsvpLinkAfterFailure({
    regenerate: false,
    previousToken: null,
    readToken: async () => "tok",
    appUrl: () => {
      throw new Error("APP_URL not set");
    },
    hasEmail: true,
  });
  assert.equal(noAppUrl, null);
});

test("TS-220: a guest's first or corrected email is worked out from the request and the earlier copy", () => {
  assert.deepEqual(rsvpEmailChange("ann@example.com", { email: null }), { firstEmail: true, correctedEmail: false });
  assert.deepEqual(rsvpEmailChange("ann@example.com", { email: "" }), { firstEmail: true, correctedEmail: false });
  assert.deepEqual(rsvpEmailChange("ann@example.com", { email: "old@example.com" }), { firstEmail: false, correctedEmail: true });
  // Same address, different capitals or spaces: not a correction.
  assert.deepEqual(rsvpEmailChange("Ann@Example.com", { email: " ann@example.com " }), { firstEmail: false, correctedEmail: false });
  // Clearing the address, or an edit that doesn't send one: neither.
  assert.deepEqual(rsvpEmailChange(null, { email: "old@example.com" }), { firstEmail: false, correctedEmail: false });
  assert.deepEqual(rsvpEmailChange(undefined, null), { firstEmail: false, correctedEmail: false });
});

// ---- 3. A retried delete's 404 ----

/** The first try gets no answer (so it's retried); the retry gets a 404 with this message. */
function retriedDelete404(error: string) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ error }), { status: 404, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => calls;
}

test("TS-220: a retried delete that finds the item gone counts as deleted", async () => {
  const calls = retriedDelete404("Guest not found");
  assert.deepEqual(await api.delete("/api/v1/weddings/w1/guests/g1"), {});
  assert.equal(calls(), 2);
});

test("TS-220: a retried delete answered 'Wedding not found' or 'This wedding was deleted' is an error, not 'deleted'", async () => {
  for (const error of ["Wedding not found", "This wedding was deleted — nothing was saved."]) {
    const calls = retriedDelete404(error);
    await assert.rejects(api.delete("/api/v1/weddings/w1/relationships/r1"), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.message, error);
      return true;
    });
    assert.equal(calls(), 2);
  }
});
