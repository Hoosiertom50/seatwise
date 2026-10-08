// TS-204 / TS-205 / TS-209 / TS-214: code-level tests for fixes found while checking the combined
// review-7 changes -- the access re-check asks for the level the route needs (approvals keep the
// real level and role), a status or label change is read back before it commits, pruning keeps the
// versions kept ones were restored from, and a new comment thread's notification is cut between
// whole characters. The database is replaced by a scripted stand-in that records each statement, so
// no database is needed. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const {
  pool,
  setPlanVersionStatus,
  setPlanVersionLabel,
  createComment,
  resolveComment,
  recheckActorAccess,
  AccessChangedError,
  planVersionsToPrune,
} = await import("@seatwise/db");
const { requireAccess, approvalActor, mayManageApproval } = await import("./access");

type Rows = Record<string, unknown>[];
type Responder = (sql: string, params: unknown[]) => Rows | undefined;

const log: string[] = [];
const realConnect = pool.connect.bind(pool);
const realQuery = pool.query.bind(pool);

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
});

// --- TS-204: the re-check asks for the level the route needs --------------------------------------

/** A wedding owned by "owner" where "c" is (at the time of the request) an Edit Couple member. */
function weddingWithCollaborator(level: string, role: string): Responder {
  return (sql) => {
    if (/SELECT "ownerId" FROM "weddings"/.test(sql)) return [{ ownerId: "owner" }];
    if (/FROM "weddings"/.test(sql)) return [{ id: "w", ownerId: "owner", name: "W" }];
    if (/FROM "wedding_collaborators"/.test(sql)) return [{ permissionLevel: level, role }];
    return undefined;
  };
}

/** A transaction connection where "c" is now `level` / `role`. */
const nowIs = (level: string, role: string) => ({
  query: async (sql: string) => ({ rows: weddingWithCollaborator(level, role)(sql, []) ?? [] }),
});

test("TS-204: someone lowered to a level that still allows the change isn't refused", async () => {
  fakeDatabase(weddingWithCollaborator("EDIT", "COUPLE"));
  const access = await requireAccess("w", "c", "COMMENT");
  assert.ok(!("error" in access));
  assert.equal(access.accessLevel, "EDIT", "the person's own level is still reported");
  assert.deepEqual(access.actor, { userId: "c", accessLevel: "COMMENT" });
  // Edit lowered to Comment while adding a comment: still allowed.
  await recheckActorAccess(nowIs("COMMENT", "COUPLE"), "w", access.actor);
  // Lowered to View: refused.
  await assert.rejects(recheckActorAccess(nowIs("VIEW", "COUPLE"), "w", access.actor), AccessChangedError);
});

test("TS-204: approvals are still re-checked against the real level and role", async () => {
  fakeDatabase(weddingWithCollaborator("COMMENT", "COUPLE"));
  const access = await requireAccess("w", "c", "COMMENT");
  assert.ok(!("error" in access));
  assert.equal(mayManageApproval(access), true);
  const judged = approvalActor(access);
  assert.deepEqual(judged, { userId: "c", accessLevel: "COMMENT", role: "COUPLE" });
  await recheckActorAccess(nowIs("COMMENT", "COUPLE"), "w", judged);
  // A Couple member lowered below Comment, or changed off Couple, is refused.
  await assert.rejects(recheckActorAccess(nowIs("VIEW", "COUPLE"), "w", judged), AccessChangedError);
  await assert.rejects(recheckActorAccess(nowIs("COMMENT", "COLLABORATOR"), "w", judged), AccessChangedError);

  // The owner's approval is judged as the owner -- even on a route whose minimum is Comment -- so
  // an owner who handed the wedding off meanwhile (now an Edit collaborator) is refused.
  fakeDatabase(weddingWithCollaborator("EDIT", "COLLABORATOR"));
  const owner = await requireAccess("w", "owner", "COMMENT");
  assert.ok(!("error" in owner));
  assert.deepEqual(owner.actor, { userId: "owner", accessLevel: "COMMENT" });
  assert.deepEqual(approvalActor(owner), { userId: "owner", accessLevel: "OWNER" });
  const handedOff = { query: async (sql: string) => ({ rows: /SELECT "ownerId"/.test(sql) ? [{ ownerId: "new-owner" }] : [{ permissionLevel: "EDIT", role: "COLLABORATOR" }] }) };
  await assert.rejects(recheckActorAccess(handedOff, "w", approvalActor(owner)), AccessChangedError);
});

test("TS-204: resolving someone else's comment is re-checked at Edit; resolving your own at Comment", async () => {
  const actor = { userId: "c", accessLevel: "COMMENT" as const };
  // Was Edit when the request came in, lowered to Comment meanwhile.
  fakeDatabase((sql, params) => {
    if (/SELECT "authorUserId" FROM "comments"/.test(sql)) return [{ authorUserId: params[0] === "mine" ? "c" : "someone-else" }];
    if (/FROM "comments" c/.test(sql)) return [{ id: params[0] }];
    return weddingWithCollaborator("COMMENT", "COLLABORATOR")(sql, params);
  });
  await assert.rejects(resolveComment("w", "theirs", "c", true, actor), AccessChangedError);
  assert.ok(!log.includes("COMMIT"));
  const mine = await resolveComment("w", "mine", "c", true, actor);
  assert.equal(mine.id, "mine");
  // TS-209: read back before the change commits.
  assert.ok(log.findIndex((s) => /FROM "comments" c/.test(s)) < log.indexOf("COMMIT"));
});

// --- TS-209: status and label changes are read back before they commit ------------------------

const readBackFails: Responder = (sql) => {
  if (/FROM "plan_versions" pv/.test(sql)) throw Object.assign(new Error("read failed"), { code: "57014" });
  if (/SELECT "isCurrent" FROM "plan_versions"/.test(sql)) return [{ isCurrent: true }];
  if (/FROM "plan_versions" WHERE id = \$1 AND "weddingId" = \$2 FOR NO KEY UPDATE/.test(sql)) {
    return [{ status: "DRAFT", isComplete: true, revision: 1, isCurrent: true }];
  }
  if (/UPDATE "plan_versions" SET label/.test(sql)) return [{ id: "plan" }];
  if (/FROM "weddings"/.test(sql)) return [{ ownerId: "owner" }];
  return undefined;
};

test("TS-209: a status change whose read-back fails saves nothing (it used to fail after COMMIT)", async () => {
  fakeDatabase(readBackFails);
  await assert.rejects(setPlanVersionStatus("plan", "wedding", "IN_REVIEW", "owner", 1), /read failed/);
  assert.ok(log.some((s) => /UPDATE "plan_versions" SET status/.test(s)), "the change was written in the transaction");
  assert.ok(!log.includes("COMMIT"), "but never committed");
  assert.equal(log.at(-1), "ROLLBACK");
});

test("TS-209: a label change whose read-back fails saves nothing (it used to fail after COMMIT)", async () => {
  fakeDatabase(readBackFails);
  await assert.rejects(setPlanVersionLabel("plan", "wedding", "Final", 1), /read failed/);
  assert.ok(log.some((s) => /UPDATE "plan_versions" SET label/.test(s)));
  assert.ok(!log.includes("COMMIT"));
  assert.equal(log.at(-1), "ROLLBACK");
});

// --- TS-205: pruning keeps what kept versions were restored from --------------------------------

const v = (n: number, extra: Partial<{ status: string; isCurrent: boolean; restoredFromId: string | null }> = {}) => ({
  id: `v${n}`,
  versionNumber: n,
  status: "DRAFT",
  isCurrent: false,
  restoredFromId: null,
  ...extra,
});

test("TS-205: nothing is pruned under the cap", () => {
  assert.deepEqual(planVersionsToPrune([v(1), v(2), v(3, { isCurrent: true })], 3), []);
});

test("TS-205: the version the current plan was restored from is kept", () => {
  // Cap 3, five versions: v1 and v2 are the oldest removable -- but the current plan came from v1.
  const versions = [v(1), v(2), v(3), v(4), v(5, { isCurrent: true, restoredFromId: "v1" })];
  assert.deepEqual(planVersionsToPrune(versions, 3), ["v2"]);
});

test("TS-205: a source only removed versions came from still goes, and approved/current never do", () => {
  // v3 (removed) came from v2 -- nothing kept needs v2, so it goes too.
  const versions = [v(1, { status: "APPROVED" }), v(2), v(3, { restoredFromId: "v2" }), v(4), v(5), v(6, { isCurrent: true })];
  assert.deepEqual(planVersionsToPrune(versions, 4), ["v2", "v3"]);
});

test("TS-205: a long chain of restores can't grow past twice the cap", () => {
  // Each version restored from the one before (the worst case for keeping sources).
  const versions = Array.from({ length: 30 }, (_, i) => v(i + 1, { isCurrent: i === 29, restoredFromId: i > 0 ? `v${i}` : null }));
  const removed = new Set(planVersionsToPrune(versions, 10));
  const kept = versions.filter((x) => !removed.has(x.id));
  assert.ok(kept.length <= 20, `kept ${kept.length}`);
  assert.ok(removed.size > 0);
  // Every version kept for its own sake still shows where it came from.
  const keptIds = new Set(kept.map((x) => x.id));
  const naive = new Set(versions.slice(0, 20).map((x) => x.id));
  for (const x of kept) if (!naive.has(x.id) && x.restoredFromId) assert.ok(keptIds.has(x.restoredFromId), `${x.id}'s source kept`);
});

// --- TS-214: a new thread's notification is cut between whole characters -----------------------

test("TS-214: a new comment thread's notification is cut with an ellipsis, never mid-emoji", async () => {
  const messages: string[] = [];
  fakeDatabase((sql, params) => {
    if (/SELECT label FROM "seating_tables"/.test(sql)) return [{ label: "Table 1" }];
    if (/INSERT INTO "comments"/.test(sql)) return [{ id: params[0], body: params[7] }];
    if (/SELECT "ownerId", name, "emailNotificationsEnabled" FROM "weddings"/.test(sql)) {
      return [{ ownerId: "owner", name: "W", emailNotificationsEnabled: false }];
    }
    if (/FROM "users" u JOIN "weddings"/.test(sql)) return [{ id: "owner", email: "o@example.invalid", emailVerifiedAt: null, wantsEmail: false }];
    if (/INSERT INTO "notifications"/.test(sql)) {
      messages.push(params[4] as string);
      return [{}];
    }
    // TS-237: the locks taken before the notification is written.
    if (/SELECT "ownerId" FROM "weddings" WHERE id = \$1 FOR KEY SHARE/.test(sql)) return [{ ownerId: "owner" }];
    if (/FROM "users" WHERE id = \$1 FOR KEY SHARE/.test(sql)) return [{}];
    return undefined;
  });
  // 119 letters then emoji: slice(0, 120) would have cut the first emoji in half.
  const body = "a".repeat(119) + "😀".repeat(10);
  await createComment("wedding", "author", { targetType: "TABLE", tableId: "table", body } as never);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.ok(message.startsWith('New comment on "Table: Table 1": '));
  assert.ok(message.endsWith("…"), message);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(message), "no half emoji");
});
