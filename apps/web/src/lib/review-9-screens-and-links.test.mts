// TS-235 / TS-228: unit tests for review 9's screen fixes and the "New link" pre-read -- the Tables
// tab's counts worked out from the current plan and the live guest list, the wedding's settings
// taken from every newer 4-second check, a vendor edit refreshed when the list is loaded again, a
// 404 after "Leave this wedding" counted as left, the Comments tab's check held back by a draft,
// and "New link" reading the old link without making one. The database is replaced by a scripted
// stand-in that records each statement, and a throwaway secret is set before lib/auth loads. Run
// with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.JWT_SECRET = randomBytes(32).toString("hex");

const { seatedHeadcountByTable, sameSeats } = await import("./table-counts");
const { weddingAfterPoll } = await import("./wedding-poll");
const { editAfterReload } = await import("./vendor-edit");
const { leaveCountsAsDone } = await import("./leave-wedding");
const { mayApplyCommentsPoll } = await import("./comments-poll");
const { ApiError } = await import("./api-client");
const { signToken } = await import("./auth");
const { pool, readGuestRsvpToken } = await import("@seatwise/db");
const { encryptText } = await import("../../../../packages/db/src/crypto");
const { NextRequest } = await import("next/server");
import type { WeddingDTO } from "@seatwise/shared";

const realQuery = pool.query.bind(pool);
const realConnect = pool.connect.bind(pool);
afterEach(() => {
  (pool as unknown as { query: unknown }).query = realQuery;
  (pool as unknown as { connect: unknown }).connect = realConnect;
});

// ---- TS-235 item 1: the Tables tab's counts ----

const guest = (id: string, headcount: number, dayOfAttendance = "ATTENDING") => ({ id, headcount, dayOfAttendance });

test("TS-235: seated counts come from the current seats and the live guest list", () => {
  const seats = [
    { guestId: "a", tableId: "t1" },
    { guestId: "b", tableId: "t1" },
    { guestId: "c", tableId: "t2" },
  ];
  const counts = seatedHeadcountByTable(seats, [guest("a", 2), guest("b", 1), guest("c", 3)], ["t1", "t2"]);
  assert.deepEqual(counts, { t1: 3, t2: 3 });
  // A guest's party grew elsewhere: the count follows the live list, without fetching the plan again.
  assert.deepEqual(seatedHeadcountByTable(seats, [guest("a", 4), guest("b", 1), guest("c", 3)], ["t1", "t2"]), { t1: 5, t2: 3 });
});

test("TS-235: a removed table, a removed guest and a guest marked not attending stop counting at once", () => {
  const seats = [
    { guestId: "a", tableId: "t1" },
    { guestId: "b", tableId: "t2" },
    { guestId: "c", tableId: "t2" },
    { guestId: "d", tableId: "t2", notAttending: true },
  ];
  const guests = [guest("a", 2), guest("b", 1, "NOT_ATTENDING"), guest("d", 5)];
  // t1 removed; c no longer on the list; b marked not attending; d's seat marked not attending.
  assert.deepEqual(seatedHeadcountByTable(seats, guests, ["t2"]), {});
  assert.deepEqual(seatedHeadcountByTable(seats, guests, ["t1", "t2"]), { t1: 2 });
});

test("TS-235: an unchanged set of seats from the 4-second check counts as the same (no redraw)", () => {
  const a = [{ guestId: "a", tableId: "t1" }];
  assert.equal(sameSeats(a, [{ guestId: "a", tableId: "t1" }]), true);
  assert.equal(sameSeats(a, [{ guestId: "a", tableId: "t2" }]), false);
  assert.equal(sameSeats(a, []), false);
  assert.equal(sameSeats(a, [{ guestId: "a", tableId: "t1", notAttending: true }]), false);
});

// ---- TS-235 item 2: the wedding's settings from every newer check ----

function wedding(over: Partial<WeddingDTO> = {}): WeddingDTO {
  return {
    id: "w",
    ownerId: "owner",
    name: "Sam & Alex",
    eventDate: "2027-06-12",
    venueName: "The Barn",
    note: null,
    guestCount: 10,
    peopleCount: 12,
    attendingCount: 12,
    settingsRevision: 3,
    emailNotificationsEnabled: true,
    sideMixing: "ALLOW_MIXING" as WeddingDTO["sideMixing"],
    sideLabel1: "Bride",
    sideLabel2: "Groom",
    rsvpCutoffDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

test("TS-235: a newer copy from the check brings the new side labels, name and date", () => {
  const cur = wedding();
  const fresh = wedding({ settingsRevision: 4, sideLabel1: "Sam", sideLabel2: "Alex", name: "S & A", eventDate: "2027-07-01" });
  const next = weddingAfterPoll(cur, fresh);
  assert.equal(next.sideLabel1, "Sam");
  assert.equal(next.sideLabel2, "Alex");
  assert.equal(next.name, "S & A");
  assert.equal(next.eventDate, "2027-07-01");
  assert.equal(next.settingsRevision, 4);
});

test("TS-235: a copy that isn't newer leaves the wedding as it is (the same object, no redraw)", () => {
  const cur = wedding({ settingsRevision: 5, sideLabel1: "Saved here" });
  assert.equal(weddingAfterPoll(cur, wedding({ settingsRevision: 5 })), cur);
  assert.equal(weddingAfterPoll(cur, wedding({ settingsRevision: 4 })), cur);
});

test("TS-235: the note comes as the server sends it to this person (left out for anyone but the owner)", () => {
  // A collaborator: the server sends null, and null is what's shown.
  assert.equal(weddingAfterPoll(wedding(), wedding({ settingsRevision: 4, note: null })).note, null);
  // The owner: the newer note is taken.
  assert.equal(weddingAfterPoll(wedding({ note: "old" }), wedding({ settingsRevision: 4, note: "new" })).note, "new");
});

// ---- TS-235 item 4: a vendor's open edit when the list is loaded again ----

type V = { id: string; name: string; contractNotes: string | null; contactName: string | null };

test("TS-235: an open vendor edit takes the fresh contract notes the View copy left out", () => {
  const viewCopy: V = { id: "v", name: "Flowers", contractNotes: null, contactName: "Kim" };
  const editCopy: V = { id: "v", name: "Flowers", contractNotes: "Deposit paid", contactName: "Kim" };
  assert.deepEqual(editAfterReload<V>({ ...viewCopy }, viewCopy, editCopy), editCopy);
});

test("TS-235: what was typed into the open vendor edit is kept when the list is loaded again", () => {
  const viewCopy: V = { id: "v", name: "Flowers", contractNotes: null, contactName: "Kim" };
  const editCopy: V = { id: "v", name: "Flowers", contractNotes: "Deposit paid", contactName: "Kim" };
  const typed = { ...viewCopy, name: "Flowers by Kim" };
  assert.deepEqual(editAfterReload<V>(typed, viewCopy, editCopy), { ...editCopy, name: "Flowers by Kim" });
});

// ---- TS-235 item 5: a 404 after "Leave this wedding" ----

test("TS-235: 'Leave this wedding' answered 404 (including 'Wedding not found') counts as left", () => {
  assert.equal(leaveCountsAsDone(new ApiError("Wedding not found", 404)), true);
  assert.equal(leaveCountsAsDone(new ApiError("This wedding was deleted — nothing was saved.", 404)), true);
  assert.equal(leaveCountsAsDone(new ApiError("Collaborator not found", 404)), true);
  assert.equal(leaveCountsAsDone(new ApiError("Something went wrong", 500)), false);
  assert.equal(leaveCountsAsDone(new ApiError("Not authenticated", 401)), false);
  assert.equal(leaveCountsAsDone(new TypeError("Failed to fetch")), false);
});

// ---- TS-228 item 4: the Comments tab's check and a draft ----

test("TS-228: a comments check that comes back while a draft is being written isn't shown", () => {
  const base = { cancelled: false, changesBefore: 1, changesNow: 1, busy: false, hasDraft: false };
  assert.equal(mayApplyCommentsPoll(base), true);
  assert.equal(mayApplyCommentsPoll({ ...base, hasDraft: true }), false);
  assert.equal(mayApplyCommentsPoll({ ...base, busy: true }), false);
  assert.equal(mayApplyCommentsPoll({ ...base, changesNow: 2 }), false);
  assert.equal(mayApplyCommentsPoll({ ...base, cancelled: true }), false);
});

// ---- TS-228 item 1: "New link" reads the old link without making one ----

const log: string[] = [];
type Rows = Record<string, unknown>[];
function fakeDatabase(respond: (sql: string, params: unknown[]) => Rows | undefined) {
  log.length = 0;
  const run = async (sql: string, params: unknown[] = []) => {
    log.push(sql.replace(/\s+/g, " ").trim());
    const rows = respond(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
}

test("TS-228: reading a guest's RSVP link never writes, and a guest with no link reads as none", async () => {
  fakeDatabase((sql) => (/SELECT "rsvpToken" FROM "guests"/.test(sql) ? [{ rsvpToken: null }] : []));
  assert.equal(await readGuestRsvpToken("g", "w"), null);
  fakeDatabase((sql) => (/SELECT "rsvpToken" FROM "guests"/.test(sql) ? [{ rsvpToken: encryptText("tok123") }] : []));
  assert.equal(await readGuestRsvpToken("g", "w"), "tok123");
  fakeDatabase(() => []);
  assert.equal(await readGuestRsvpToken("missing", "w"), null);
  assert.ok(!log.some((s) => /^UPDATE/.test(s)));
});

/** One signed-in owner of wedding "w", and guest "g" (no email) who has never had an RSVP link. */
function weddingWithLinklessGuest() {
  fakeDatabase((sql) => {
    const s = sql.trim();
    if (/FROM "users"/.test(s)) {
      return [{ id: "u1", email: "u1@example.invalid", name: "u1", passwordHash: "x", sessionVersion: 0, emailVerifiedAt: new Date() }];
    }
    if (/revoked_sessions/.test(s)) return [];
    if (/SELECT "ownerId" FROM "weddings"/.test(s)) return [{ ownerId: "u1" }];
    if (/FROM "weddings"/.test(s)) return [{ id: "w", ownerId: "u1", name: "W", rsvpCutoffDate: null }];
    if (/SELECT "rsvpToken" FROM "guests"/.test(s)) return [{ rsvpToken: null }];
    if (/FROM "guests"/.test(s)) return [{ id: "g", weddingId: "w", firstName: "Ana", lastName: "Lee", email: null, notes: null, rsvpNotes: null }];
    if (/^UPDATE "guests" SET "rsvpToken" = \$1, "rsvpTokenHash" = \$2/.test(s)) return [{}];
    return [];
  });
}

test("TS-228: 'New link' for a guest who never had one makes only the new link (no throwaway link first)", async () => {
  weddingWithLinklessGuest();
  const token = await signToken({ sub: "u1", email: "u1@example.invalid", authTime: Math.floor(Date.now() / 1000), sessionVersion: 0 });
  const { POST } = await import("../app/api/v1/weddings/[weddingId]/guests/[guestId]/rsvp-link/route");
  const res: Response = await POST(
    new NextRequest("http://localhost/api/v1/weddings/w/guests/g/rsvp-link", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ regenerate: true }),
    }),
    { params: Promise.resolve({ weddingId: "w", guestId: "g" }) }
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.match(body.rsvp.url, /\/rsvp\/[0-9a-f]{64}$/);
  // The link-making statement (COALESCE keeps an existing link, else makes one) never ran.
  assert.ok(!log.some((s) => s.includes('COALESCE("rsvpToken"')), log.join("\n"));
  const readAt = log.findIndex((s) => s.startsWith('SELECT "rsvpToken" FROM "guests"'));
  const regenerateAt = log.findIndex((s) => s.startsWith('UPDATE "guests" SET "rsvpToken" = $1, "rsvpTokenHash" = $2'));
  assert.ok(readAt >= 0 && regenerateAt > readAt, log.join("\n"));
  assert.equal(log.filter((s) => s.startsWith("UPDATE")).length, 1, log.join("\n"));
});
