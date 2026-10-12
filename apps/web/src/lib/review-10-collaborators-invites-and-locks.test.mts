// TS-242 / TS-237 item 4 / TS-246: unit tests for review 10's collaborator, invite and lock fixes
// -- a re-sent invite checks "already a collaborator" after revoking the old one, an accept that
// lost a race answers 409 "try again", a vendor edit and a plan-version rename read access again
// before their own row's lock (and a vendor's lost race is said in vendor words), resolving a
// resolved comment changes nothing, the wedding-wide email switch moves the settings revision on
// (so other tabs follow it), and a settings box with typing in it notices its own setting saved
// elsewhere. The database is replaced by a scripted stand-in that records each statement; the
// screens are covered by e2e/tests/cross-cutting.review-10-collaborators-invites-and-locks-hold.spec.ts.
// Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.JWT_SECRET = randomBytes(32).toString("hex");

const db = await import("@seatwise/db");
const { pool } = db;
const { signToken } = await import("./auth");
const { NextRequest } = await import("next/server");
const { vendorSameMomentResponse, VENDOR_SAME_MOMENT_MESSAGE, INVITE_ACCEPT_SAME_MOMENT_MESSAGE } = await import(
  "./same-moment-answers"
);
const { boxesChangedUnderneath, emailSwitchRevision, savedBoxValues } = await import("./settings-boxes");
const { weddingAfterPoll } = await import("./wedding-poll");
import type { WeddingDTO } from "@seatwise/shared";

type Rows = Record<string, unknown>[];
type Responder = (sql: string, params: unknown[]) => Rows | undefined;

const log: string[] = [];
const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);

function fakeDatabase(respond: Responder) {
  log.length = 0;
  const run = async (sql: string, p: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    log.push(flat);
    const rows = respond(flat, p) ?? [];
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
}

afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
});

function indexOf(re: RegExp): number {
  return log.findIndex((s) => re.test(s));
}

const ACCESS_RECHECK = /FROM "weddings" WHERE id = \$1 FOR KEY SHARE/;
const OWNER: { userId: string; accessLevel: "OWNER" } = { userId: "owner-1", accessLevel: "OWNER" };

// ---- TS-242 item 3: re-sending an invite at the moment it's accepted ----

test("TS-242: a re-sent invite checks 'already a collaborator' after revoking the old invite", async () => {
  fakeDatabase((sql) => {
    if (/FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return [{ ownerId: "owner-1" }];
    if (/FROM "users" WHERE id = \$1/.test(sql)) return [{ id: "owner-1", email: "owner@example.invalid" }];
    if (/INSERT INTO "wedding_invites"/.test(sql)) {
      return [{ id: "i1", weddingId: "w1", email: "pat@example.invalid", status: "PENDING", expiresAt: new Date(Date.now() + 86_400_000) }];
    }
    return undefined;
  });
  await db.createInvite("w1", "owner-1", "Pat@example.invalid", "EDIT", "COLLABORATOR");
  const revoke = indexOf(/^UPDATE "wedding_invites" SET status = 'REVOKED'/);
  const check = indexOf(/FROM "wedding_collaborators" wc JOIN "users" u/);
  const insert = indexOf(/^INSERT INTO "wedding_invites"/);
  assert.ok(revoke > 0 && check > revoke && insert > check, `order was: ${log.join(" | ")}`);
});

test("TS-242: a re-sent invite to someone who became a collaborator is refused, and the revoke is rolled back", async () => {
  fakeDatabase((sql) => {
    if (/FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return [{ ownerId: "owner-1" }];
    if (/FROM "users" WHERE id = \$1/.test(sql)) return [{ id: "owner-1", email: "owner@example.invalid" }];
    // The accept committed while the revoke waited for it: the new statement sees the member.
    if (/FROM "wedding_collaborators" wc JOIN "users" u/.test(sql)) return [{ id: "c1" }];
    return undefined;
  });
  await assert.rejects(
    db.createInvite("w1", "owner-1", "pat@example.invalid", "EDIT", "COLLABORATOR"),
    (err: { code?: string }) => err.code === "ALREADY_COLLABORATOR"
  );
  assert.equal(indexOf(/^INSERT INTO "wedding_invites"/), -1);
  assert.equal(log.at(-1), "ROLLBACK");
  assert.ok(!log.includes("COMMIT"));
});

/** A signed-in, confirmed u1 holding a pending invite to wedding w (sent to their own address). */
function pendingInviteFor(acceptFails: string) {
  fakeDatabase((sql) => {
    const s = sql.trim();
    if (/FROM "users"/.test(s)) {
      return [{ id: "u1", email: "u1@example.invalid", name: "u1", passwordHash: "x", sessionVersion: 0, emailVerifiedAt: new Date() }];
    }
    if (/revoked_sessions/.test(s)) return [];
    if (/^SELECT "weddingId" FROM "wedding_invites" WHERE token = \$1/.test(s)) {
      throw Object.assign(new Error("deadlock detected"), { code: acceptFails });
    }
    if (/FROM "wedding_invites" wi JOIN "weddings" w/.test(s)) {
      return [
        {
          id: "i1",
          weddingId: "w",
          email: "u1@example.invalid",
          role: "COLLABORATOR",
          permissionLevel: "EDIT",
          status: "PENDING",
          invitedByUserId: "owner-1",
          expiresAt: new Date(Date.now() + 86_400_000),
          acceptedAt: null,
          createdAt: new Date(),
          emailedAt: null,
          weddingName: "W",
        },
      ];
    }
    return [];
  });
}

for (const code of ["40P01", "40001"]) {
  test(`TS-242: an accept that lost a race (${code}) answers 409 'try again', not a server error`, async () => {
    pendingInviteFor(code);
    const token = await signToken({ sub: "u1", email: "u1@example.invalid", authTime: Math.floor(Date.now() / 1000), sessionVersion: 0 });
    const { POST } = await import("../app/api/v1/invites/[token]/accept/route");
    const res: Response = await POST(
      new NextRequest("http://localhost/api/v1/invites/abc/accept", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ token: "a".repeat(64) }) }
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, INVITE_ACCEPT_SAME_MOMENT_MESSAGE);
  });
}

// ---- TS-242 item 4: vendor edit and plan-version rename vs wedding delete ----

test("TS-242: a vendor edit reads access again (the wedding) before it locks the vendor", async () => {
  fakeDatabase((sql) => {
    if (ACCESS_RECHECK.test(sql)) return [{ ownerId: "owner-1" }];
    if (/FROM "vendors" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/.test(sql)) {
      return [{ revision: 1, category: "FLORIST", categoryOther: null }];
    }
    if (/SELECT .* FROM "vendors" WHERE id = \$1/.test(sql)) return [{ id: "v1" }];
    return undefined;
  });
  await db.updateVendorForWedding("v1", "w1", { name: "Blooms" }, 1, OWNER);
  const recheck = indexOf(ACCESS_RECHECK);
  const vendorLock = indexOf(/FROM "vendors" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/);
  assert.ok(recheck > 0 && vendorLock > recheck, `order was: ${log.join(" | ")}`);
});

// TS-253: and the current plan's row comes before both -- a wedding delete holds the current plan
// and then needs the wedding to itself, so reading access first deadlocked with it.
test("TS-242/TS-253: renaming a plan version locks the current plan, then reads access again, then locks the version", async () => {
  fakeDatabase((sql) => {
    if (ACCESS_RECHECK.test(sql)) return [{ ownerId: "owner-1" }];
    if (/FROM "plan_versions" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/.test(sql)) return [{ revision: 3, isCurrent: true }];
    return undefined;
  });
  // The rename finds no row to update (the stand-in has none) -- what matters is the lock order.
  await db.setPlanVersionLabel("p1", "w1", "Final", 3, OWNER);
  const recheck = indexOf(ACCESS_RECHECK);
  const planLock = indexOf(/FROM "plan_versions" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/);
  const currentPlanLock = indexOf(/FROM "plan_versions" WHERE "weddingId" = \$1 AND "isCurrent" FOR NO KEY UPDATE/);
  assert.ok(currentPlanLock > 0 && recheck > currentPlanLock && planLock > recheck, `order was: ${log.join(" | ")}`);
});

test("TS-242: a vendor change that lost a race is said in vendor words, not the plan's", async () => {
  for (const code of ["40P01", "40001"]) {
    const res = vendorSameMomentResponse(Object.assign(new Error("x"), { code }));
    assert.ok(res);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, VENDOR_SAME_MOMENT_MESSAGE);
    assert.doesNotMatch(body.error, /plan/i);
  }
  assert.equal(vendorSameMomentResponse(Object.assign(new Error("x"), { code: "23503" })), null);
});

// ---- TS-242 item 5: resolving a comment that's already resolved ----

test("TS-242: resolving an already-resolved comment keeps who resolved it and when", async () => {
  const resolvedAt = new Date("2026-10-01T15:00:00Z");
  const asStored = { id: "c1", resolvedAt, resolvedByUserId: "first", resolvedByName: "First Person" };
  fakeDatabase((sql) => {
    if (/SELECT "authorUserId" FROM "comments"/.test(sql)) return [{ authorUserId: "second" }];
    if (ACCESS_RECHECK.test(sql)) return [{ ownerId: "second" }];
    if (/WHERE c\.id = \$1/.test(sql)) return [asStored];
    return undefined;
  });
  const back = await db.resolveComment("w1", "c1", "second", true, { userId: "second", accessLevel: "OWNER" });
  const update = log.find((s) => s.startsWith('UPDATE "comments" SET "resolvedAt"'));
  assert.ok(update && /AND "resolvedAt" IS NULL/.test(update), update);
  assert.deepEqual(back, asStored);
});

// ---- TS-237 item 4: the wedding-wide email switch across tabs ----

test("TS-237: the email switch moves the settings revision on and answers the new one", async () => {
  const updatedAt = new Date();
  fakeDatabase((sql) => (/^UPDATE "weddings"/.test(sql.trim()) ? [{ settingsRevision: 8, updatedAt }] : undefined));
  assert.deepEqual(await db.setEmailNotificationsEnabled("w1", "owner-1", false), { settingsRevision: 8, updatedAt });
  assert.match(log[0], /"settingsRevision" = "settingsRevision" \+ 1/);
  assert.match(log[0], /WHERE id = \$2 AND "ownerId" = \$3/);
  fakeDatabase(() => undefined);
  assert.equal(await db.setEmailNotificationsEnabled("w1", "not-owner", false), null);
});

const wedding = (over: Partial<WeddingDTO> = {}): WeddingDTO =>
  ({
    id: "w1",
    name: "Ana & Bo",
    eventDate: "2027-06-12",
    venueName: "The Barn",
    note: "",
    sideMixing: "ENCOURAGE",
    sideLabel1: "Bride",
    sideLabel2: "Groom",
    rsvpCutoffDate: null,
    emailNotificationsEnabled: true,
    ownerId: "owner-1",
    settingsRevision: 4,
    updatedAt: "2026-10-08T12:00:00.000Z",
    ...over,
  }) as unknown as WeddingDTO;

test("TS-237: another tab's check picks up the switch once its revision has moved on", () => {
  const here = wedding();
  const switchedOff = wedding({ emailNotificationsEnabled: false, settingsRevision: 5 });
  assert.equal(weddingAfterPoll(here, switchedOff).emailNotificationsEnabled, false);
  // Without the bump (the old behaviour) the check kept the old switch.
  assert.equal(weddingAfterPoll(here, wedding({ emailNotificationsEnabled: false })).emailNotificationsEnabled, true);
});

test("TS-237: the tab that pressed the switch takes the new revision only when nothing else was saved in between", () => {
  assert.equal(emailSwitchRevision(4, 5), 5);
  assert.equal(emailSwitchRevision(4, 6), null); // another tab saved too: its next save is checked
  assert.equal(emailSwitchRevision(5, 5), null); // the 4-second check got there first
});

// ---- TS-246 item 1: a box with typing in it, its setting saved elsewhere ----

test("TS-246: a box with typing in it whose own setting was saved elsewhere is noticed", () => {
  const old = wedding();
  const fresh = wedding({ name: "Ana & Bo's Big Day", settingsRevision: 5 });
  const boxes = { ...savedBoxValues(old), "setting-name": "Ana and Bo" };
  assert.deepEqual(boxesChangedUnderneath(old, fresh, boxes), ["setting-name"]);
});

test("TS-246: untouched boxes, other settings, the switch and typing that already matches don't count", () => {
  const old = wedding();
  // Untouched box: it simply takes the new value.
  assert.deepEqual(boxesChangedUnderneath(old, wedding({ name: "New", settingsRevision: 5 }), savedBoxValues(old)), []);
  // Typing in the name, but only the venue (and the email switch) changed elsewhere.
  const typed = { ...savedBoxValues(old), "setting-name": "Ana and Bo" };
  assert.deepEqual(
    boxesChangedUnderneath(old, wedding({ venueName: "The Mill", emailNotificationsEnabled: false, settingsRevision: 5 }), typed),
    []
  );
  // The other tab saved exactly what is typed here.
  assert.deepEqual(boxesChangedUnderneath(old, wedding({ name: "Ana and Bo", settingsRevision: 5 }), typed), []);
  // Side labels, note and cutoff are each their own box.
  const sides = { ...savedBoxValues(old), "setting-side-2": "Sam", "setting-rsvp-cutoff": "2027-05-01" };
  assert.deepEqual(
    boxesChangedUnderneath(old, wedding({ sideLabel2: "Alex", rsvpCutoffDate: "2027-04-01", settingsRevision: 5 }), sides),
    ["setting-side-2", "setting-rsvp-cutoff"]
  );
});
