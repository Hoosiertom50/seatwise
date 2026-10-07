// TS-234: unit tests for review 9's "changes made at the same moment" fixes -- guest changes wait
// for a first Generate (the wedding's lock when there's no plan yet), a timeline edit or reorder
// re-reads access before it locks its entries and answers a lost race with 409, the notification's
// membership check waits for a removal, and invites are sent one at a time per wedding (with a
// hand-off revoking the new owner's own invites and the owner unable to accept one). The database
// is replaced by a scripted stand-in that records each statement, so nothing real is needed; the
// real races are covered by the e2e specs guest-list.guest-changes-during-the-first-generate-*
// and collaboration.one-pending-invite-per-address-*. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const db = await import("@seatwise/db");
const { pool } = db;
const { timelineChangeRefusedResponse, TIMELINE_SAME_MOMENT_MESSAGE } = await import("./timeline-answers");

type Rows = Record<string, unknown>[];
type Responder = (sql: string, params: unknown[]) => Rows | undefined;

const log: string[] = [];
const params: unknown[][] = [];
const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);

function fakeDatabase(respond: Responder) {
  log.length = 0;
  params.length = 0;
  const run = async (sql: string, p: unknown[] = []) => {
    log.push(sql.replace(/\s+/g, " ").trim());
    params.push(p);
    const rows = respond(sql, p) ?? [];
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
}

afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
});

const PLAN_LOCK = /FROM "plan_versions" WHERE "weddingId" = \$1 AND "isCurrent" FOR NO KEY UPDATE/;
const WEDDING_LOCK = /FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/;
const ACCESS_RECHECK = /FROM "weddings" WHERE id = \$1 FOR KEY SHARE/;

function indexOf(re: RegExp, from = 0): number {
  for (let i = from; i < log.length; i++) if (re.test(log[i])) return i;
  return -1;
}

/** A wedding with no plan yet: every plan lock finds nothing; the wedding's lock finds its owner. */
const noPlanYet: Responder = (sql) => {
  if (WEDDING_LOCK.test(sql) || ACCESS_RECHECK.test(sql)) return [{ ownerId: "owner-1" }];
  return undefined;
};

// ---- 1. Guest changes wait for a first Generate ----

test("lockCurrentPlanOrWedding takes the wedding's lock, then looks again, when there is no plan yet", async () => {
  fakeDatabase(noPlanYet);
  const client = await pool.connect();
  const id = await db.lockCurrentPlanOrWedding(client as never, "w1");
  assert.equal(id, null);
  const first = indexOf(PLAN_LOCK);
  const wedding = indexOf(WEDDING_LOCK);
  assert.ok(first === 0 && wedding > first, "the plan is tried first, then the wedding's lock");
  assert.ok(indexOf(PLAN_LOCK, wedding + 1) > wedding, "and the plan is looked for again under the wedding's lock");
});

test("lockCurrentPlanOrWedding takes only the plan's lock when there is a plan", async () => {
  fakeDatabase((sql) => (PLAN_LOCK.test(sql) ? [{ id: "p1" }] : undefined));
  const client = await pool.connect();
  assert.equal(await db.lockCurrentPlanOrWedding(client as never, "w1"), "p1");
  assert.equal(indexOf(WEDDING_LOCK), -1);
  assert.equal(log.length, 1);
});

test("removing a seating rule waits for the wedding's lock (no plan yet) before access and the delete", async () => {
  fakeDatabase((sql, p) => {
    if (/DELETE FROM "guest_relationships"/.test(sql)) return [{ guestAId: "g1", guestBId: "g2" }];
    return noPlanYet(sql, p);
  });
  const removed = await db.deleteRelationshipForWedding("r1", "w1", { userId: "owner-1", accessLevel: "OWNER" });
  assert.deepEqual(removed, { guestAId: "g1", guestBId: "g2" });
  const wedding = indexOf(WEDDING_LOCK);
  const recheck = indexOf(ACCESS_RECHECK);
  const del = indexOf(/DELETE FROM "guest_relationships"/);
  assert.ok(wedding > 0 && recheck > wedding && del > recheck, `order was: ${log.join(" | ")}`);
  assert.equal(log.at(-1), "COMMIT");
});

test("deleting a guest waits for the wedding's lock when there is no plan yet", async () => {
  fakeDatabase((sql, p) => {
    if (/DELETE FROM "guests"/.test(sql)) return [{ dayOfAttendance: "ATTENDING" }];
    return noPlanYet(sql, p);
  });
  assert.equal(await db.deleteGuestForWedding("g1", "w1", "owner-1", { userId: "owner-1", accessLevel: "OWNER" }), true);
  const wedding = indexOf(WEDDING_LOCK);
  assert.ok(wedding > 0 && indexOf(/DELETE FROM "guests"/) > wedding);
});

test("editing a guest's headcount waits for the wedding's lock when there is no plan yet", async () => {
  fakeDatabase(noPlanYet);
  // The guest isn't found (the stand-in has no rows) -- what matters is the locks taken first.
  await db.updateGuestForWedding("g1", "w1", { headcount: 3 }, undefined, "owner-1").catch(() => null);
  const plan = indexOf(PLAN_LOCK);
  const wedding = indexOf(WEDDING_LOCK);
  assert.ok(plan > 0 && wedding > plan, `order was: ${log.join(" | ")}`);
  assert.ok(indexOf(/FROM "guests"/) > wedding, "the guest is read after the locks");
});

test("re-checking one guest's seat reads the seat inside the transaction, after the lock", async () => {
  fakeDatabase((sql) => (PLAN_LOCK.test(sql) ? [{ id: "p1" }] : undefined));
  const { newlyFlagged } = await db.resyncGuestSeat("w1", "g1");
  assert.deepEqual(newlyFlagged, []);
  assert.match(log[0], /^BEGIN/, "nothing is read before the transaction starts");
  const lock = indexOf(PLAN_LOCK);
  const seat = indexOf(/FROM "seat_assignments"/);
  assert.ok(lock > 0 && seat > lock, `order was: ${log.join(" | ")}`);
  assert.deepEqual(params[seat], ["p1", ["g1"]]);
});

test("re-checking guests' seats, recounting after an add and recounting completeness all wait for a first Generate", async () => {
  for (const run of [
    () => db.resyncGuestsSeats("w1", ["g1"]),
    () => db.refreshPlanAfterGuestAdded("w1", "Ann Lee", "owner-1"),
    () => db.recomputeCurrentPlanCompleteness("w1"),
  ]) {
    fakeDatabase(noPlanYet);
    await run();
    assert.ok(indexOf(WEDDING_LOCK) > indexOf(PLAN_LOCK), `no wedding lock in: ${log.join(" | ")}`);
    assert.equal(log.at(-1), "COMMIT");
  }
});

// ---- 2. Timeline edit / reorder vs a wedding delete ----

test("a timeline edit re-reads access (the wedding row) before it locks the entry", async () => {
  fakeDatabase((sql) => (ACCESS_RECHECK.test(sql) ? [{ ownerId: "owner-1" }] : undefined));
  const result = await db.updateTimelineEntry("e1", "w1", { description: "Toasts" }, undefined, { userId: "owner-1", accessLevel: "OWNER" });
  assert.equal(result, null); // the entry isn't there in the stand-in
  const recheck = indexOf(ACCESS_RECHECK);
  const entry = indexOf(/FROM "timeline_entries" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/);
  assert.ok(recheck > 0 && entry > recheck, `order was: ${log.join(" | ")}`);
});

test("a timeline reorder re-reads access before it reads or locks the entries", async () => {
  fakeDatabase((sql) => (ACCESS_RECHECK.test(sql) ? [{ ownerId: "owner-1" }] : undefined));
  const result = await db.reorderTimelineEntry("e1", "w1", "UP", { userId: "owner-1", accessLevel: "OWNER" });
  assert.equal(result, null);
  const recheck = indexOf(ACCESS_RECHECK);
  assert.ok(recheck > 0 && indexOf(/FROM "timeline_entries"/) > recheck, `order was: ${log.join(" | ")}`);
});

test("a timeline change that lost a race answers 409, not a server error", async () => {
  for (const code of ["40P01", "40001"]) {
    const res = timelineChangeRefusedResponse(Object.assign(new Error("x"), { code }));
    assert.equal(res?.status, 409);
    assert.equal(((await res!.json()) as { error: string }).error, TIMELINE_SAME_MOMENT_MESSAGE);
  }
  assert.equal(timelineChangeRefusedResponse(new db.WeddingDeletedError())?.status, 404);
  assert.equal(timelineChangeRefusedResponse(new db.AccessChangedError())?.status, 403);
  assert.equal(timelineChangeRefusedResponse(new Error("something else")), null);
});

// ---- 3. A removed member isn't notified ----

test("the notification's membership check share-locks the access row, so it waits for a removal", async () => {
  fakeDatabase((sql) => {
    if (/SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings"/.test(sql)) {
      return [{ ownerId: "owner-1", name: "W", emailNotificationsEnabled: false }];
    }
    if (/UNION/.test(sql)) return [{ id: "u2", email: "u2@example.invalid", emailVerifiedAt: null, wantsEmail: false }];
    return undefined;
  });
  await db.notifyWeddingCollaborators("w1", "owner-1", "GUEST_ADDED", "Ann Lee was added.");
  const insert = log.find((s) => s.startsWith('INSERT INTO "notifications"'));
  assert.ok(insert, "a notification was attempted");
  assert.match(insert!, /FROM "wedding_collaborators" WHERE "weddingId" = \$2 AND "userId" = \$3 FOR KEY SHARE\)/);
});

// ---- 4. Invites ----

const inviteRow = {
  id: "i2",
  weddingId: "w1",
  email: "pat@example.invalid",
  role: "COLLABORATOR",
  permissionLevel: "VIEW",
  status: "PENDING",
  invitedByUserId: "owner-1",
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  createdAt: new Date(),
};

test("sending an invite checks, revokes and inserts in one transaction under the wedding's lock", async () => {
  fakeDatabase((sql) => {
    if (WEDDING_LOCK.test(sql)) return [{ ownerId: "owner-1" }];
    if (/SELECT id, email FROM "users"/.test(sql)) return [{ id: "owner-1", email: "owner@example.invalid" }];
    if (/INSERT INTO "wedding_invites"/.test(sql)) return [inviteRow];
    return undefined;
  });
  const invite = await db.createInvite("w1", "owner-1", " Pat@Example.invalid ", "VIEW", "COLLABORATOR");
  assert.equal(invite.id, "i2");
  assert.match(log[0], /^BEGIN/);
  const wedding = indexOf(WEDDING_LOCK);
  const revoke = indexOf(/UPDATE "wedding_invites" SET status = 'REVOKED'/);
  const insert = indexOf(/INSERT INTO "wedding_invites"/);
  assert.ok(wedding === 1 && revoke > wedding && insert > revoke, `order was: ${log.join(" | ")}`);
  assert.equal(log.at(-1), "COMMIT");
});

test("an invite refused by the one-pending-invite rule says so plainly and saves nothing", async () => {
  fakeDatabase((sql) => {
    if (WEDDING_LOCK.test(sql)) return [{ ownerId: "owner-1" }];
    if (/INSERT INTO "wedding_invites"/.test(sql)) {
      throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "wedding_invites_one_pending_per_email" });
    }
    return undefined;
  });
  await assert.rejects(
    db.createInvite("w1", "owner-1", "pat@example.invalid", "VIEW", "COLLABORATOR"),
    (err: unknown) => err instanceof db.InviteError && err.code === "PENDING_EXISTS" && err.message === db.INVITE_JUST_SENT_MESSAGE
  );
  assert.equal(log.at(-1), "ROLLBACK");
});

test("the wedding's owner can't accept an invite to it, and the invite isn't claimed", async () => {
  fakeDatabase((sql) => {
    if (/SELECT "weddingId" FROM "wedding_invites" WHERE token = \$1/.test(sql)) return [{ weddingId: "w1" }];
    if (ACCESS_RECHECK.test(sql)) return [{ ownerId: "owner-1" }];
    return undefined;
  });
  assert.deepEqual(await db.acceptInvite("a".repeat(64), "owner-1"), { error: "ALREADY_OWNER" });
  assert.equal(indexOf(/UPDATE "wedding_invites" SET status = 'ACCEPTED'/), -1);
  assert.equal(indexOf(/INSERT INTO "wedding_collaborators"/), -1);
  assert.equal(log.at(-1), "ROLLBACK");
});

test("accepting reads the wedding's owner (waiting for a hand-off) before it claims the invite", async () => {
  fakeDatabase((sql) => {
    if (/SELECT "weddingId" FROM "wedding_invites" WHERE token = \$1/.test(sql)) return [{ weddingId: "w1" }];
    if (ACCESS_RECHECK.test(sql)) return [{ ownerId: "owner-1" }];
    return undefined;
  });
  await db.acceptInvite("a".repeat(64), "someone-else");
  const owner = indexOf(ACCESS_RECHECK);
  assert.ok(owner > 0 && indexOf(/UPDATE "wedding_invites" SET status = 'ACCEPTED'/) > owner);
});

test("a hand-off revokes the new owner's own pending invites for that wedding", async () => {
  fakeDatabase((sql) => {
    if (/FROM "weddings" WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ ownerId: "owner-1" }];
    if (/SELECT "userId" FROM "wedding_collaborators" WHERE id = \$1/.test(sql)) return [{ userId: "u2" }];
    if (/SELECT id FROM "users" WHERE id = \$1 FOR KEY SHARE/.test(sql)) return [{ id: "u2" }];
    if (/FOR UPDATE OF wc/.test(sql)) return [{ userId: "u2", name: "Pat", emailNotificationsEnabled: true }];
    if (/UPDATE "weddings" w SET "ownerId"/.test(sql)) return [{ ownerEmails: true }];
    return undefined;
  });
  await db.transferWeddingOwnership("w1", "owner-1", "c2");
  const revoke = indexOf(/UPDATE "wedding_invites" SET status = 'REVOKED'/);
  assert.ok(revoke > indexOf(/FOR UPDATE OF wc/), `order was: ${log.join(" | ")}`);
  assert.match(log[revoke], /lower\(email\) = \(SELECT lower\(email\) FROM "users" WHERE id = \$2\)/);
  assert.deepEqual(params[revoke], ["w1", "u2"]);
  assert.equal(log.at(-1), "COMMIT");
});

test("the one-pending-invite migration revokes older duplicates before it creates the index", () => {
  const sql = readFileSync(
    path.resolve(import.meta.dirname, "../../../../packages/db/prisma/migrations/20261007200100_one_pending_invite_per_email/migration.sql"),
    "utf8"
  );
  const revoke = sql.indexOf(`UPDATE "wedding_invites"`);
  const index = sql.indexOf(`CREATE UNIQUE INDEX "wedding_invites_one_pending_per_email"`);
  assert.ok(revoke >= 0 && index > revoke, "duplicates are tidied up first, so the index can't fail on existing data");
  assert.match(sql, /ON "wedding_invites" \("weddingId", lower\(email\)\)\s+WHERE status = 'PENDING'/);
  // The newest pending invite is the one kept.
  assert.match(sql, /newer\."createdAt" > wi\."createdAt"/);
});
