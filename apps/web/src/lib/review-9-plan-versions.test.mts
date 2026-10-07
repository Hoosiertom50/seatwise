// TS-231 / TS-235 / TS-228: code-level tests for review 9's plan-version fixes -- replacing an
// approved plan tells everyone (Generate, Restore, removing a seated table), pruning keeps older
// approved versions bounded and never removes the version being made, the comparison marks guests
// not attending now, and Undo's must-sit check is made again by the server under the plan's lock.
// The database is replaced by a scripted stand-in that records each statement, so no database is
// needed. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const {
  pool,
  planVersionsToPrune,
  createPlanVersionWithAssignments,
  moveGuestAssignment,
  comparePlanVersions,
  removeSeatingTable,
} = await import("@seatwise/db");
const { moveGuestAssignmentSchema, undoSplitsGroup, UNDO_SPLITS_GROUP_MESSAGE } = await import("@seatwise/shared");
const { undoPlanFor, undoSeatsBeforeFor, undoWouldSplitGroup } = await import("./plan-undo");
const { REPLACES_APPROVED_PLAN } = await import("./plan-approval-text");

type Rows = Record<string, unknown>[];
type Responder = (sql: string, params: unknown[]) => Rows | undefined;

const log: { sql: string; params: unknown[] }[] = [];
const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);

function fakeDatabase(respond: Responder) {
  log.length = 0;
  const run = async (sql: string, params: unknown[] = []) => {
    log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    const rows = respond(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release: () => {} });
  (pool as unknown as { query: unknown }).query = run;
}

afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
});

/** The in-app notifications written, as [recipient, type, message]. */
const notificationsWritten = () =>
  log.filter((q) => /INSERT INTO "notifications"/.test(q.sql)).map((q) => [q.params[2], q.params[3], q.params[4]]);

/** Answers the notification queries: owner "owner", collaborator "c", emails off. */
const members: Responder = (sql) => {
  if (/SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings"/.test(sql)) {
    return [{ ownerId: "owner", name: "W", emailNotificationsEnabled: false }];
  }
  if (/FROM "users" u JOIN "weddings" w/.test(sql)) {
    return [
      { id: "owner", email: "o@example.test", emailVerifiedAt: null, wantsEmail: false },
      { id: "c", email: "c@example.test", emailVerifiedAt: null, wantsEmail: false },
    ];
  }
  if (/INSERT INTO "notifications"/.test(sql)) return [{}];
  return undefined;
};

// --- TS-235 #6: pruning --------------------------------------------------------------------------

const v = (n: number, extra: Partial<{ status: string; isCurrent: boolean; restoredFromId: string | null }> = {}) => ({
  id: `v${n}`,
  versionNumber: n,
  status: "DRAFT",
  isCurrent: false,
  restoredFromId: null,
  ...extra,
});

test("TS-235: 120 approved older versions are pruned back to the cap, keeping the newest approved ones", () => {
  const versions = [...Array.from({ length: 120 }, (_, i) => v(i + 1, { status: "APPROVED" })), v(121, { isCurrent: true })];
  const removed = new Set(planVersionsToPrune(versions, 50, { keepId: "v121" }));
  const kept = versions.filter((x) => !removed.has(x.id));
  assert.equal(kept.length, 50, "bounded by the cap");
  assert.ok(kept.some((x) => x.id === "v121"), "the current one stays");
  for (const n of [116, 117, 118, 119, 120]) assert.ok(kept.some((x) => x.id === `v${n}`), `newest approved v${n} stays`);
  assert.ok(removed.has("v1"), "the oldest approved goes");
});

test("TS-235: with 49 approved versions, a new comparison draft is never removed in its own save", () => {
  const versions = [
    ...Array.from({ length: 49 }, (_, i) => v(i + 1, { status: "APPROVED" })),
    v(50, { isCurrent: true }),
    v(51), // the comparison draft this save made
  ];
  const removed = planVersionsToPrune(versions, 50, { keepId: "v51" });
  assert.ok(!removed.includes("v51"), "the new draft is kept");
  assert.deepEqual(removed, ["v1"], "the oldest approved one goes instead");
});

test("TS-235: unapproved versions go before approved ones, and the newest approved ones always stay", () => {
  const versions = [
    v(1, { status: "APPROVED" }),
    v(2, { status: "APPROVED" }),
    v(3),
    v(4, { status: "APPROVED" }),
    v(5, { status: "APPROVED" }),
    v(6, { isCurrent: true }),
  ];
  // Cap 4, two to go: the draft first, then the oldest approved (2 approved always kept here).
  assert.deepEqual(planVersionsToPrune(versions, 4, { approvedKept: 2 }), ["v3", "v1"]);
  // Nothing removable beyond the newest approved ones: nothing goes.
  assert.deepEqual(planVersionsToPrune(versions.filter((x) => x.id !== "v3"), 1, { approvedKept: 4 }), []);
});

test("TS-235: the source a kept version (the new restore) was restored from is kept too", () => {
  const versions = [
    ...Array.from({ length: 10 }, (_, i) => v(i + 1, { status: "APPROVED" })),
    v(11, { isCurrent: true }),
    v(12, { restoredFromId: "v1" }), // a restore saved as a draft by this save
  ];
  const removed = planVersionsToPrune(versions, 8, { keepId: "v12", approvedKept: 2 });
  assert.ok(!removed.includes("v1"), "v1 is what the new version was restored from");
  assert.ok(!removed.includes("v12"));
  assert.ok(removed.length > 0);
});

// --- TS-235 #7: the comparison marks guests not attending now ------------------------------------

test("TS-235: a comparison marks guests not attending now and leaves them out of the counts", async () => {
  fakeDatabase((sql) => {
    if (/SELECT id, "versionNumber", label, "createdAt" FROM "plan_versions"/.test(sql)) {
      return [
        { id: "a", versionNumber: 1, label: null, createdAt: new Date() },
        { id: "b", versionNumber: 2, label: null, createdAt: new Date() },
      ];
    }
    if (/FROM "seat_assignments" sa/.test(sql)) {
      assert.match(sql, /"dayOfAttendance" <> 'ATTENDING'\) AS "notAttending"/);
      return [
        { planVersionId: "a", guestId: "g1", guestName: "Ann Lee", tableId: "t1", tableLabel: "1", notAttending: false },
        { planVersionId: "b", guestId: "g1", guestName: "Ann Lee", tableId: "t2", tableLabel: "2", notAttending: false },
        // Declined since version 1 was made: seated there, gone from version 2.
        { planVersionId: "a", guestId: "g2", guestName: "Bo Diaz", tableId: "t1", tableLabel: "1", notAttending: true },
      ];
    }
    return undefined;
  });
  const result = await comparePlanVersions("w", "a", "b");
  assert.deepEqual(result.summary, { movedCount: 1, addedCount: 0, removedCount: 0, unchangedCount: 0 });
  const bo = result.guests.find((g) => g.guestId === "g2")!;
  assert.equal(bo.notAttending, true);
  assert.equal(bo.status, "removed");
  assert.equal(result.guests.find((g) => g.guestId === "g1")!.notAttending, undefined);
});

// --- TS-228 #3: Undo's must-sit check, again on the server -----------------------------------------

test("TS-228: undoSplitsGroup and the seats Undo sends", () => {
  assert.equal(undoSplitsGroup(["a", "b"], { a: "T1", b: "T1" }, "T1"), false);
  assert.equal(undoSplitsGroup(["a", "b"], { a: "T1" }, "T1"), true, "b had no seat before");
  assert.equal(undoSplitsGroup(["a", "b"], { a: "T1", b: "T2" }, "T1"), true);
  // An inherited key never counts as a seat.
  assert.equal(undoSplitsGroup(["toString"], {}, "T1"), true);

  const plan = undoPlanFor("a", "T2", [{ guestId: "a", tableId: "T1" }, { guestId: "x", tableId: "T3" }], [{ guestId: "a", tableId: "T2" }, { guestId: "x", tableId: "T3" }])!;
  assert.equal(undoWouldSplitGroup(plan, ["a"]), false);
  assert.deepEqual(undoSeatsBeforeFor(plan, ["a", "b"]), { a: "T1" }, "only the group, and only who had a seat");
});

test("TS-228: the move request takes undoSeatsBefore, bounded in size", () => {
  const ok = moveGuestAssignmentSchema.safeParse({ guestId: "a", tableId: "T1", undoSeatsBefore: { a: "T1" } });
  assert.ok(ok.success);
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`g${i}`, "T1"]));
  assert.equal(moveGuestAssignmentSchema.safeParse({ guestId: "a", tableId: "T1", undoSeatsBefore: many }).success, false);
  assert.equal(moveGuestAssignmentSchema.safeParse({ guestId: "a", tableId: "T1", undoSeatsBefore: { a: "" } }).success, false);
});

/**
 * A plan where guest "a" moves to table "T1". Before the lock, "a" has no must-sit partner; under
 * the plan's lock a must-sit rule a-b has just been added (`ruleAddedMeanwhile`).
 */
function undoScenario(ruleAddedMeanwhile: boolean): Responder {
  let locked = false;
  return (sql) => {
    if (/FOR NO KEY UPDATE/.test(sql) && /"plan_versions"/.test(sql)) {
      locked = true;
      return [{ revision: 3, isCurrent: true }];
    }
    if (/SELECT "isCurrent" FROM "plan_versions"/.test(sql)) return [{ isCurrent: true }];
    if (/FROM "guests" WHERE id = \$1 AND "weddingId" = \$2/.test(sql)) {
      return [{ id: "a", name: "Ann Lee", headcount: 1, requiresAccessibleTable: false, dayOfAttendance: "ATTENDING" }];
    }
    if (/FROM "seating_tables" WHERE id = \$1/.test(sql)) {
      return [{ id: "T1", label: "Table 1", capacity: 10, isAccessible: true, isRestricted: false }];
    }
    if (/FROM "guests" WHERE "weddingId" = \$1 AND "dayOfAttendance" = 'ATTENDING'/.test(sql)) {
      return [
        { id: "a", name: "Ann Lee", headcount: 1, requiresAccessibleTable: false },
        { id: "b", name: "Bo Diaz", headcount: 1, requiresAccessibleTable: false },
      ];
    }
    if (/FROM "guest_relationships"/.test(sql)) {
      return locked && ruleAddedMeanwhile ? [{ guestAId: "a", guestBId: "b", type: "MUST_SIT_TOGETHER" }] : [];
    }
    // Stops the move just after the undo check, so the test can tell it got past it.
    if (/"dayOfAttendance" <> 'ATTENDING' FOR SHARE/.test(sql)) return [{ name: "Past the undo check" }];
    return undefined;
  };
}

test("TS-228: an undo is refused under the plan's lock when a must-sit partner was linked meanwhile", async () => {
  fakeDatabase(undoScenario(true));
  // The screen saw "a" alone, at T1 before the move.
  await assert.rejects(
    moveGuestAssignment("plan", "w", "a", "T1", "owner", 3, undefined, { a: "T1" }),
    (err: Error) => err.message === UNDO_SPLITS_GROUP_MESSAGE
  );
  const lockAt = log.findIndex((q) => /FOR NO KEY UPDATE/.test(q.sql));
  const ruleReadAt = log.findIndex((q, i) => i > lockAt && /type = 'MUST_SIT_TOGETHER'/.test(q.sql));
  assert.ok(lockAt >= 0 && ruleReadAt > lockAt, "the group is read again under the plan's lock");
  assert.ok(!log.some((q) => /INSERT INTO "seat_assignments"/.test(q.sql)), "nobody moved");
  assert.ok(!log.some((q) => q.sql === "COMMIT"));
});

test("TS-228: an undo goes ahead when the group is the one the screen saw", async () => {
  fakeDatabase(undoScenario(false));
  await assert.rejects(moveGuestAssignment("plan", "w", "a", "T1", "owner", 3, undefined, { a: "T1" }), /Past the undo check/);
  // And an ordinary move (no undoSeatsBefore) isn't checked at all.
  fakeDatabase(undoScenario(true));
  await assert.rejects(moveGuestAssignment("plan", "w", "a", "T1", "owner", 3), /Past the undo check/);
});

// --- TS-231: replacing an approved plan tells everyone -----------------------------------------------

function generateScenario(currentStatus: string): Responder {
  return (sql, params) => {
    const asMember = members(sql, params);
    if (asMember) return asMember;
    if (/SELECT id FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return [{ id: "w" }];
    // The owner's access, read again under the lock.
    if (/SELECT "ownerId" FROM "weddings"/.test(sql)) return [{ ownerId: "owner" }];
    if (/SELECT id FROM "plan_versions" WHERE "weddingId" = \$1 AND "isCurrent" FOR NO KEY UPDATE/.test(sql)) return [{ id: "old" }];
    if (/SELECT status FROM "plan_versions" WHERE id = \$1/.test(sql)) return [{ status: currentStatus }];
    if (/COALESCE\(MAX\("versionNumber"\), 0\) \+ 1/.test(sql)) return [{ next: 7 }];
    if (/AS "seated"/.test(sql)) return [{ seated: 0, unassigned: 0 }];
    if (/COUNT\(\*\)/.test(sql)) return [{ count: 0, n: 0, unassigned: 0, needsReassignment: 0, needsReassignmentCount: 0 }];
    return undefined;
  };
}

const generateInput = (mayReplaceApproved: boolean, makeCurrent = true) => ({
  isComplete: true,
  warnings: [],
  assignments: [],
  unassignedGuestIds: [],
  makeCurrent,
  mayReplaceApproved,
  actorAccess: { userId: "owner", accessLevel: "OWNER" as const },
});

test("TS-231: Generate that replaces an approved plan tells the other members, after it's saved", async () => {
  fakeDatabase(generateScenario("APPROVED"));
  const result = await createPlanVersionWithAssignments("w", generateInput(true));
  assert.equal(result.savedAsDraftBecauseApproved, false);
  assert.deepEqual(notificationsWritten(), [["c", "STATUS_CHANGED", "The approved seating plan was replaced by version 7 (Draft)."]]);
  const commitAt = log.findIndex((q) => q.sql === "COMMIT");
  assert.ok(commitAt >= 0 && commitAt < log.findIndex((q) => /INSERT INTO "notifications"/.test(q.sql)));
});

test("TS-231: no notice when nothing approved is replaced (a draft, a draft plan, or kept back)", async () => {
  fakeDatabase(generateScenario("DRAFT"));
  await createPlanVersionWithAssignments("w", generateInput(true));
  assert.deepEqual(notificationsWritten(), []);

  fakeDatabase(generateScenario("APPROVED"));
  await createPlanVersionWithAssignments("w", generateInput(true, false));
  assert.deepEqual(notificationsWritten(), [], "a comparison draft replaces nothing");

  fakeDatabase(generateScenario("APPROVED"));
  const keptBack = await createPlanVersionWithAssignments("w", generateInput(false));
  assert.equal(keptBack.savedAsDraftBecauseApproved, true);
  assert.deepEqual(notificationsWritten(), []);
});

test("TS-231: a failing notification never turns the saved Generate into an error", async () => {
  const base = generateScenario("APPROVED");
  fakeDatabase((sql, params) => {
    if (/SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings"/.test(sql)) {
      throw Object.assign(new Error("db busy"), { code: "57014" });
    }
    return base(sql, params);
  });
  const result = await createPlanVersionWithAssignments("w", generateInput(true));
  assert.ok(result.planVersionId);
});

test("TS-231: removing a table that seats guests on an approved plan tells the other members", async () => {
  const scenario = (status: string): Responder => (sql, params) => {
    const asMember = members(sql, params);
    if (asMember) return asMember;
    if (/SELECT id FROM "plan_versions" WHERE "weddingId" = \$1 AND "isCurrent" FOR NO KEY UPDATE/.test(sql)) return [{ id: "plan" }];
    if (/SELECT label FROM "seating_tables"/.test(sql)) return [{ label: "Table 4" }];
    if (/SELECT COUNT\(\*\)::int AS n FROM "seat_assignments"/.test(sql)) return [{ n: 2 }];
    if (/SELECT status FROM "plan_versions" WHERE id = \$1/.test(sql)) return [{ status }];
    if (/COUNT\(\*\)/.test(sql)) return [{ count: 0, n: 0, unassigned: 0, needsReassignment: 0, needsReassignmentCount: 0 }];
    return undefined;
  };
  fakeDatabase(scenario("APPROVED"));
  const removed = await removeSeatingTable("t4", "w", "owner", true, 2);
  assert.equal(removed.status, "REMOVED");
  assert.deepEqual(notificationsWritten(), [
    ["c", "TABLE_CHANGED", 'Table "Table 4" was removed from the approved plan — 2 guests were left unassigned.'],
  ]);

  fakeDatabase(scenario("DRAFT"));
  await removeSeatingTable("t4", "w", "owner", true, 2);
  assert.deepEqual(notificationsWritten(), [], "a draft plan is edited all the time -- no notice");
});

test("TS-231: the replace-approved warning reads plainly", () => {
  assert.match(REPLACES_APPROVED_PLAN, /^This replaces the approved plan\./);
});
