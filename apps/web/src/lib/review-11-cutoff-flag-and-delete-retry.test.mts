// TS-251 / TS-253: unit tests for review 11's Collaborators-tab fixes -- the "changed in another
// tab" flag taken (and forgotten) by every way a settings box is saved or put back, including the
// RSVP cutoff's "Save anyway" and "Change it", and a retried "Delete this wedding" answered 404
// counted as deleted. The network is replaced by a scripted fetch. Run with
// `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { WeddingDTO } from "@seatwise/shared";

const { boxesChangedUnderneath, savedBoxValues, takeChangedFlags } = await import("./settings-boxes");
type SettingsBoxKey = import("./settings-boxes").SettingsBoxKey;
const { deleteCountsAsDone } = await import("./leave-wedding");
const { api, ApiError } = await import("./api-client");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const wedding = (over: Partial<WeddingDTO> = {}): WeddingDTO =>
  ({
    id: "w1",
    name: "Ana and Bo",
    eventDate: "2030-06-01",
    venueName: null,
    sideLabel1: "Bride",
    sideLabel2: "Groom",
    note: null,
    rsvpCutoffDate: null,
    settingsRevision: 5,
    ...over,
  }) as WeddingDTO;

// ---- TS-251: the RSVP cutoff's "Save anyway" and "Change it" ----

test("TS-251: a past cutoff waiting on 'Save anyway' is flagged when another tab saves the cutoff", () => {
  const old = wedding();
  const fresh = wedding({ rsvpCutoffDate: "2029-01-01", settingsRevision: 6 });
  const boxes = { ...savedBoxValues(old), "setting-rsvp-cutoff": "2020-01-01" };
  assert.deepEqual(boxesChangedUnderneath(old, fresh, boxes), ["setting-rsvp-cutoff"]);
});

test("TS-251: 'Save anyway' on a flagged cutoff is refused once, and the flag is forgotten", () => {
  const flags = new Set<SettingsBoxKey>(["setting-rsvp-cutoff"]);
  // Refused: the other tab's cutoff isn't what this tab is about to save.
  assert.equal(takeChangedFlags(flags, ["setting-rsvp-cutoff"], "2020-01-01", "2029-01-01"), true);
  assert.equal(flags.has("setting-rsvp-cutoff"), false);
  // The next real change is a fresh one -- not refused (it used to be, the flag stayed set).
  assert.equal(takeChangedFlags(flags, ["setting-rsvp-cutoff"], "2029-02-01", "2029-01-01"), false);
});

test("TS-251: a flagged box about to save what's already the latest isn't refused", () => {
  const flags = new Set<SettingsBoxKey>(["setting-rsvp-cutoff"]);
  assert.equal(takeChangedFlags(flags, ["setting-rsvp-cutoff"], "2029-01-01", "2029-01-01"), false);
  assert.equal(flags.size, 0);
});

test("TS-251: 'Change it' forgets the flag without touching another box's", () => {
  const flags = new Set<SettingsBoxKey>(["setting-rsvp-cutoff", "setting-name"]);
  takeChangedFlags(flags, ["setting-rsvp-cutoff"], "", "");
  assert.deepEqual([...flags], ["setting-name"]);
});

test("TS-251: an unflagged box is never refused", () => {
  const flags = new Set<SettingsBoxKey>();
  assert.equal(takeChangedFlags(flags, ["setting-rsvp-cutoff"], "2020-01-01", "2029-01-01"), false);
});

// ---- TS-253 item 1: a retried "Delete this wedding" ----

/** The first try lands on the server but its answer is lost; the retry is answered `second`. */
function lostThenAnswered(status: number, body: object): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => calls;
}

test("TS-253: a retried wedding delete answered 'Wedding not found' counts as deleted", async () => {
  const calls = lostThenAnswered(404, { error: "Wedding not found" });
  const err = await api.delete("/api/v1/weddings/w1").then(
    () => null,
    (e: unknown) => e
  );
  assert.equal(calls(), 2);
  assert.ok(err instanceof ApiError);
  assert.equal(deleteCountsAsDone(err), true);
});

test("TS-253: other delete failures still show as errors", async () => {
  lostThenAnswered(403, { error: "Only the owner can delete this wedding." });
  const err = await api.delete("/api/v1/weddings/w1").then(
    () => null,
    (e: unknown) => e
  );
  assert.equal(deleteCountsAsDone(err), false);
  assert.equal(deleteCountsAsDone(new ApiError("Something went wrong", 500)), false);
  assert.equal(deleteCountsAsDone(new TypeError("Failed to fetch")), false);
});

// ---- TS-255: a wedding handed off between the owner check and the delete is not "deleted" ----

test("TS-255: deleteWeddingForOwner tells a handed-off wedding apart from one already gone", async () => {
  const db = await import("@seatwise/db");
  const { pool, deleteWeddingForOwner } = db;
  const realConnect = pool.connect.bind(pool);
  const scripted = (row: Record<string, unknown> | undefined) => {
    const statements: string[] = [];
    (pool as unknown as { connect: unknown }).connect = async () => ({
      query: async (sql: string) => {
        const flat = sql.replace(/\s+/g, " ").trim();
        statements.push(flat);
        const rows = /FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(flat) && row ? [row] : [];
        return { rows, rowCount: rows.length };
      },
      release: () => {},
    });
    return statements;
  };
  try {
    let statements = scripted({ id: "w1", ownerId: "someone-else" });
    assert.equal(await deleteWeddingForOwner("w1", "owner-1"), "not-owner");
    assert.equal(statements.some((s) => s.startsWith("DELETE")), false);
    statements = scripted(undefined);
    assert.equal(await deleteWeddingForOwner("w1", "owner-1"), "gone");
    assert.equal(statements.some((s) => s.startsWith("DELETE")), false);
  } finally {
    (pool as unknown as { connect: unknown }).connect = realConnect;
  }
});

test("TS-255: a retried wedding delete answered 403 (handed off meanwhile) is an error, not deleted", () => {
  assert.equal(deleteCountsAsDone(new ApiError("Only the wedding's owner can delete it — you aren't its owner any more.", 403)), false);
});
