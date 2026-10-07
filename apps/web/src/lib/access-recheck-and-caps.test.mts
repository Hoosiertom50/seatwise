// TS-204 / TS-205: code-level tests of the lock order and checks a change runs under -- the
// approval takes the wedding's lock before the plan's and re-reads the person's access after both;
// every other change re-reads it inside its own transaction; the per-wedding caps are counted
// under the wedding's lock. The database is replaced by a scripted stand-in that records each
// statement, so no database is needed. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const db = await import("@seatwise/db");
const {
  pool,
  setPlanVersionStatus,
  createSeatingTable,
  createGuest,
  quickCreateSeatingTables,
  createTimelineEntry,
  createVendor,
  setBudgetForWedding,
  ensureVendorShareToken,
  regenerateGuestRsvpToken,
  AccessChangedError,
  WeddingCapError,
  WEDDING_CAPS,
  weddingCapMessage,
  pruneOldPlanVersions,
} = db;

type Rows = Record<string, unknown>[];
type Responder = (sql: string, params: unknown[]) => Rows | undefined;

const log: string[] = [];
const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);

/** Swaps the pool for a stand-in: every statement is logged, and `respond` decides its rows. */
function fakeDatabase(respond: Responder) {
  log.length = 0;
  const run = async (sql: string, params: unknown[] = []) => {
    log.push(sql.replace(/\s+/g, " ").trim());
    return { rows: respond(sql, params) ?? [], rowCount: (respond(sql, params) ?? []).length };
  };
  const client = { query: run, release: () => {} };
  (pool as unknown as { connect: unknown }).connect = async () => client;
  (pool as unknown as { query: unknown }).query = run;
}

afterEach(() => {
  (pool as unknown as { connect: unknown }).connect = realConnect;
  (pool as unknown as { query: unknown }).query = realQuery;
});

const WEDDING_LOCK = /FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/;
const ACCESS_RECHECK = /FROM "wedding_collaborators" WHERE "weddingId" = \$1 AND "userId" = \$2 FOR SHARE/;
const indexOf = (re: RegExp) => log.findIndex((s) => re.test(s));

/** Answers for a wedding owned by "owner", where "collab" is now a View collaborator. */
function weddingWhereCollabIsNowView(extra: Responder = () => undefined): Responder {
  return (sql, params) => {
    const answered = extra(sql, params);
    if (answered) return answered;
    if (/SELECT "ownerId" FROM "weddings"/.test(sql)) return [{ ownerId: "owner" }];
    if (/FROM "wedding_collaborators"/.test(sql)) return [{ permissionLevel: "VIEW", role: "COLLABORATOR" }];
    return undefined;
  };
}

test("TS-204: approving takes the wedding's lock, then the plan's, then re-reads access -- and refuses a lowered Couple member", async () => {
  fakeDatabase(
    weddingWhereCollabIsNowView((sql) => {
      if (/SELECT "isCurrent" FROM "plan_versions"/.test(sql)) return [{ isCurrent: true }];
      if (/FROM "plan_versions" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/.test(sql)) {
        return [{ status: "IN_REVIEW", isComplete: true, revision: 3, isCurrent: true }];
      }
      return undefined;
    })
  );
  await assert.rejects(
    setPlanVersionStatus("plan", "wedding", "APPROVED", "collab", 3, {
      mayApprove: true,
      mayLeaveApproved: true,
      mayMoveDraftAndReview: true,
      judgedAccess: { userId: "collab", accessLevel: "COMMENT", role: "COUPLE" },
    }),
    AccessChangedError
  );
  const wedding = indexOf(WEDDING_LOCK);
  const plan = indexOf(/FROM "plan_versions" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/);
  const recheck = indexOf(ACCESS_RECHECK);
  assert.ok(wedding >= 0, "the wedding's lock is taken");
  assert.ok(plan > wedding, "the plan's lock comes after the wedding's");
  assert.ok(recheck > plan, "the access re-check comes after both locks");
  assert.ok(!log.some((s) => /UPDATE "plan_versions" SET status/.test(s)), "nothing is saved");
  assert.equal(log.at(-1), "ROLLBACK");
});

test("TS-204: a hand-off made while an approval waited -- the old owner is refused", async () => {
  fakeDatabase((sql) => {
    if (/SELECT "isCurrent" FROM "plan_versions"/.test(sql)) return [{ isCurrent: true }];
    if (/FOR NO KEY UPDATE/.test(sql) && /plan_versions/.test(sql)) return [{ status: "DRAFT", isComplete: true, revision: 1, isCurrent: true }];
    // The wedding now belongs to someone else; the old owner is an Edit collaborator.
    if (/SELECT "ownerId" FROM "weddings"/.test(sql)) return [{ ownerId: "new-owner" }];
    if (/FROM "wedding_collaborators"/.test(sql)) return [{ permissionLevel: "EDIT", role: "COLLABORATOR" }];
    return undefined;
  });
  await assert.rejects(
    setPlanVersionStatus("plan", "wedding", "APPROVED", "old-owner", undefined, {
      mayApprove: true,
      judgedAccess: { userId: "old-owner", accessLevel: "OWNER" },
    }),
    AccessChangedError
  );
});

test("TS-204: the one-statement changes now re-read access in the same transaction, after any wedding lock", async () => {
  const actor = { userId: "collab", accessLevel: "EDIT" as const };
  const cases: [string, () => Promise<unknown>, boolean][] = [
    ["add a table", () => createSeatingTable("wedding", { label: "T", capacity: 8 }, actor), true],
    ["add a guest", () => createGuest("wedding", { firstName: "A", lastName: "B" }, actor), true],
    ["quick-create tables", () => quickCreateSeatingTables("wedding", { count: 2, capacity: 8, shape: "ROUND", labelPrefix: "T" }, actor), true],
    ["add a timeline entry", () => createTimelineEntry("wedding", { time: "16:00", description: "x" }, actor), true],
    ["add a vendor", () => createVendor("wedding", { name: "V", category: "OTHER" } as never, actor), true],
    ["set the budget", () => setBudgetForWedding("wedding", 100, undefined, actor), true],
    ["make a vendor link", () => ensureVendorShareToken("vendor", "wedding", actor), false],
    ["make a new RSVP link", () => regenerateGuestRsvpToken("guest", "wedding", actor), false],
  ];
  for (const [name, change, locksWedding] of cases) {
    fakeDatabase(weddingWhereCollabIsNowView());
    await assert.rejects(change(), AccessChangedError, name);
    const recheck = indexOf(ACCESS_RECHECK);
    assert.ok(recheck > 0, `${name}: access re-read`);
    assert.equal(log[0].startsWith("BEGIN"), true, `${name}: in a transaction`);
    if (locksWedding) assert.ok(indexOf(WEDDING_LOCK) > 0 && indexOf(WEDDING_LOCK) < recheck, `${name}: wedding lock first`);
    assert.ok(!log.some((s) => /^(INSERT|UPDATE)/.test(s)), `${name}: nothing saved`);
    assert.equal(log.at(-1), "ROLLBACK", name);
  }
});

test("TS-204: a change whose access still holds goes ahead", async () => {
  fakeDatabase((sql) => {
    if (/SELECT "ownerId" FROM "weddings"/.test(sql)) return [{ ownerId: "owner" }];
    if (/FROM "wedding_collaborators"/.test(sql)) return [{ permissionLevel: "EDIT", role: "COLLABORATOR" }];
    if (/count\(\*\)/i.test(sql)) return [{ n: 3, count: 3 }];
    if (/INSERT INTO "seating_tables"/.test(sql)) return [{ id: "t1", label: "T" }];
    return undefined;
  });
  const table = await createSeatingTable("wedding", { label: "T", capacity: 8 }, { userId: "collab", accessLevel: "EDIT" });
  assert.equal(table.id, "t1");
  assert.equal(log.at(-1), "COMMIT");
});

// --- TS-205 caps -------------------------------------------------------------------------------

function weddingWithCount(n: number): Responder {
  return (sql) => {
    if (/SELECT "ownerId" FROM "weddings"/.test(sql)) return [{ ownerId: "owner" }];
    if (/SELECT count\(\*\)::int AS n/.test(sql)) return [{ n }];
    if (/SELECT label FROM "seating_tables"/.test(sql)) return [];
    return undefined;
  };
}

test("TS-205: the caps are the agreed numbers", () => {
  assert.equal(WEDDING_CAPS.guests, 2000);
  assert.equal(WEDDING_CAPS.tables, 300);
  assert.equal(WEDDING_CAPS.relationships, 3000);
  assert.equal(WEDDING_CAPS.planVersionsKept, 50);
});

test("TS-205: a table past the cap is refused with a plain message, counted under the wedding's lock", async () => {
  fakeDatabase(weddingWithCount(300));
  await assert.rejects(createSeatingTable("wedding", { label: "T", capacity: 8 }), (err: unknown) => {
    assert.ok(err instanceof WeddingCapError);
    assert.match((err as Error).message, /^A wedding can have up to 300 tables/);
    return true;
  });
  assert.ok(indexOf(WEDDING_LOCK) < indexOf(/SELECT count\(\*\)::int AS n FROM "seating_tables"/));
  assert.ok(!log.some((s) => s.startsWith("INSERT")));
});

test("TS-205: quick-create past the cap says how many more fit", async () => {
  fakeDatabase(weddingWithCount(295));
  await assert.rejects(
    quickCreateSeatingTables("wedding", { count: 10, capacity: 8, shape: "ROUND", labelPrefix: "Table" }),
    /A wedding can have up to 300 tables\. This one has 295, so there's room for 5 more tables, not 10\./
  );
  // Exactly up to the cap is fine.
  fakeDatabase(weddingWithCount(290));
  await quickCreateSeatingTables("wedding", { count: 10, capacity: 8, shape: "ROUND", labelPrefix: "Table" }).catch(() => {});
  assert.ok(log.filter((s) => s.startsWith("INSERT INTO \"seating_tables\"")).length === 10);
});

test("TS-205: guests past 2,000 are refused", async () => {
  fakeDatabase(weddingWithCount(2000));
  await assert.rejects(createGuest("wedding", { firstName: "A", lastName: "B" }), /A wedding can have up to 2,000 guests, and this one has reached that/);
});

test("TS-205: the cap messages read plainly", () => {
  assert.equal(
    weddingCapMessage("relationships", 3000, 1),
    "A wedding can have up to 3,000 seating rules, and this one has reached that — remove some seating rules before adding more."
  );
  assert.equal(
    weddingCapMessage("guests", 1999, 5),
    "A wedding can have up to 2,000 guests. This one has 1,999, so there's room for 1 more guest, not 5."
  );
});

test("TS-205 / TS-235: pruning reads the versions and removes only the chosen ones, never the current or new one", async () => {
  fakeDatabase(() => undefined);
  const versions = Array.from({ length: 52 }, (_, i) => ({
    id: `v${i + 1}`,
    versionNumber: i + 1,
    status: i === 0 ? "APPROVED" : "DRAFT",
    isCurrent: i === 51,
    restoredFromId: null,
  }));
  const seen: { sql: string; params?: unknown[] }[] = [];
  const removed = await pruneOldPlanVersions({ query: async (sql: string, params?: unknown[]) => {
    seen.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    if (/^SELECT/.test(seen.at(-1)!.sql)) return { rows: versions, rowCount: versions.length };
    return { rows: [], rowCount: (params?.[1] as string[]).length };
  } }, "wedding", "v52");
  assert.equal(seen.length, 2);
  assert.match(seen[0].sql, /FROM "plan_versions" WHERE "weddingId" = \$1/);
  assert.match(seen[1].sql, /DELETE FROM "plan_versions" WHERE "weddingId" = \$1 AND id = ANY\(\$2::text\[\]\) AND id <> \$3 AND NOT "isCurrent"/);
  // 52 versions, cap 50: the two oldest that aren't approved (v1 is, and is among the newest 5 approved) go.
  assert.deepEqual(seen[1].params, ["wedding", ["v2", "v3"], "v52"]);
  assert.equal(removed, 2);
});

// --- TS-204: one access reading, and the owner-only note ---------------------------------------

const { mayManageApproval, approvalActor, weddingForViewer } = await import("./access");

test("TS-204: who may approve comes from the request's one access reading, and the same reading is re-checked", () => {
  const owner = { accessLevel: "OWNER" as const, role: null, actor: { userId: "o", accessLevel: "OWNER" as const } };
  const coupleComment = { accessLevel: "COMMENT" as const, role: "COUPLE" as const, actor: { userId: "c", accessLevel: "COMMENT" as const } };
  const coupleView = { accessLevel: "VIEW" as const, role: "COUPLE" as const, actor: { userId: "c", accessLevel: "VIEW" as const } };
  const editCollab = { accessLevel: "EDIT" as const, role: "COLLABORATOR" as const, actor: { userId: "e", accessLevel: "EDIT" as const } };
  assert.equal(mayManageApproval(owner), true);
  assert.equal(mayManageApproval(coupleComment), true);
  assert.equal(mayManageApproval(coupleView), false);
  assert.equal(mayManageApproval(editCollab), false);
  // The re-check carries the role the decision was made from, so a Couple member made a
  // Collaborator meanwhile is refused.
  assert.deepEqual(approvalActor(coupleComment), { userId: "c", accessLevel: "COMMENT", role: "COUPLE" });
  assert.deepEqual(approvalActor(owner), { userId: "o", accessLevel: "OWNER" });
});

test("TS-204: the wedding note is sent to its owner only", () => {
  const wedding = { id: "w", ownerId: "owner", name: "W", note: "Owner's private note" };
  assert.equal(weddingForViewer(wedding, "owner"), wedding);
  const forCollaborator = weddingForViewer(wedding, "someone-else");
  assert.equal("note" in forCollaborator, false);
  assert.equal(forCollaborator.name, "W");
  // The original isn't changed.
  assert.equal(wedding.note, "Owner's private note");
});

// TS-204 (Copilot review on PR #102): the re-check reads who owns the wedding with FOR KEY SHARE, so
// it waits for a hand-off (which takes FOR UPDATE) and sees the new owner -- the old owner's change
// used to go through as the owner's. It must not take the ordinary wedding lock (NO KEY UPDATE),
// which would make it wait behind Generate and others and could deadlock.
test("the re-check reads the owner with FOR KEY SHARE, so it waits for a hand-off but nothing else", async () => {
  const seen: string[] = [];
  const q = {
    async query(sql: string) {
      seen.push(sql);
      return { rows: /FROM "weddings"/.test(sql) ? [{ ownerId: "owner-1" }] : [] };
    },
  };
  await db.recheckActorAccess(q as never, "w-1", { userId: "owner-1", accessLevel: "EDIT" });
  assert.match(seen[0], /FROM "weddings" WHERE id = \$1 FOR KEY SHARE$/);
  assert.doesNotMatch(seen[0], /NO KEY UPDATE/);
});
