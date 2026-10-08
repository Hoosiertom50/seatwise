// TS-237 #2 / #6 and TS-243 #5: code-level tests for review 10's plan-version fixes -- Generate and
// Restore replace an approved plan only when the person confirmed that very version (checked under
// the wedding lock); the table re-check's seat order breaks ties by guest id, as Generate does; and
// plan-version labels follow the same text rules as every other label.
// The database is replaced by a scripted stand-in that records each statement, so no database is
// needed. Run with `pnpm --filter @seatwise/web test`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const {
  pool,
  createPlanVersionWithAssignments,
  restorePlanVersion,
  ApprovedPlanNotConfirmedError,
  APPROVED_PLAN_NOT_CONFIRMED_MESSAGE,
  SEAT_ORDER,
} = await import("@seatwise/db");
const { setPlanVersionLabelSchema, generatePlanVersionSchema, restorePlanVersionSchema, generateSeatingPlan } = await import(
  "@seatwise/shared"
);
const { approvedPlanNotConfirmedResponse } = await import("./approved-plan-response");
const { APPROVED_PLAN_NOT_CONFIRMED } = await import("./plan-approval-text");

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

// --- TS-237 #2: replacing an approved plan needs that version confirmed ----------------------------

/** A wedding whose current plan "v1" has the given status. Notifications: nobody to tell. */
function weddingScenario(currentStatus: string): Responder {
  return (sql) => {
    if (/SELECT id FROM "weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return [{ id: "w" }];
    if (/SELECT id FROM "plan_versions" WHERE "weddingId" = \$1 AND "isCurrent" FOR NO KEY UPDATE/.test(sql)) return [{ id: "v1" }];
    if (/SELECT status FROM "plan_versions" WHERE id = \$1/.test(sql)) return [{ status: currentStatus }];
    if (/SELECT id, "versionNumber", "createdAt" FROM "plan_versions" WHERE id = \$1 AND "weddingId" = \$2/.test(sql)) {
      return [{ id: "v0", versionNumber: 1, createdAt: new Date() }];
    }
    if (/COALESCE\(MAX\("versionNumber"\), 0\) \+ 1/.test(sql)) return [{ next: 3 }];
    if (/AS "seated"/.test(sql)) return [{ seated: 0, unassigned: 0 }];
    if (/COUNT\(\*\)/.test(sql)) return [{ count: 0, n: 0, unassigned: 0, needsReassignment: 0, needsReassignmentCount: 0 }];
    return undefined;
  };
}

const generateInput = (replacesApprovedVersionId: string | null | undefined, extra: { makeCurrent?: boolean; mayReplaceApproved?: boolean } = {}) => ({
  isComplete: true,
  warnings: [],
  assignments: [],
  unassignedGuestIds: [],
  makeCurrent: extra.makeCurrent ?? true,
  mayReplaceApproved: extra.mayReplaceApproved ?? true,
  replacesApprovedVersionId,
});

const replacedCurrent = () => log.some((q) => /SET "isCurrent" = false/.test(q.sql));
const committed = () => log.some((q) => q.sql === "COMMIT");

test("TS-237: Generate on an approved plan nobody confirmed replacing saves nothing and names the approved version", async () => {
  for (const ack of [null, "some-older-version"]) {
    fakeDatabase(weddingScenario("APPROVED"));
    await assert.rejects(
      createPlanVersionWithAssignments("w", generateInput(ack)),
      (err: unknown) =>
        err instanceof ApprovedPlanNotConfirmedError &&
        err.approvedVersionId === "v1" &&
        err.message === "The plan was approved a moment ago — confirm again to replace it."
    );
    assert.ok(!replacedCurrent(), `nothing replaced (ack ${ack})`);
    assert.ok(!log.some((q) => /INSERT INTO "plan_versions"/.test(q.sql)), "no new version");
    assert.ok(!committed());
    // Checked under the wedding lock and the plan's lock, before anything is written.
    const lockAt = log.findIndex((q) => /"weddings" WHERE id = \$1 FOR NO KEY UPDATE/.test(q.sql));
    const statusAt = log.findIndex((q) => /SELECT status FROM "plan_versions" WHERE id = \$1/.test(q.sql));
    assert.ok(lockAt >= 0 && statusAt > lockAt);
  }
});

test("TS-237: Generate replaces the approved plan when that very version was confirmed", async () => {
  fakeDatabase(weddingScenario("APPROVED"));
  const result = await createPlanVersionWithAssignments("w", generateInput("v1"));
  assert.ok(result.planVersionId);
  assert.equal(result.savedAsDraftBecauseApproved, false);
  assert.ok(replacedCurrent());
  assert.ok(committed());
});

test("TS-237: no confirmation is needed for a draft plan, a comparison draft, or someone who can't replace it", async () => {
  fakeDatabase(weddingScenario("DRAFT"));
  await createPlanVersionWithAssignments("w", generateInput(null));
  assert.ok(replacedCurrent(), "a draft plan is replaced as before");

  fakeDatabase(weddingScenario("APPROVED"));
  await createPlanVersionWithAssignments("w", generateInput(null, { makeCurrent: false }));
  assert.ok(!replacedCurrent() && committed(), "a comparison draft replaces nothing");

  fakeDatabase(weddingScenario("APPROVED"));
  const keptBack = await createPlanVersionWithAssignments("w", generateInput(null, { mayReplaceApproved: false }));
  assert.equal(keptBack.savedAsDraftBecauseApproved, true, "saved as a comparison draft, as before");

  // An internal caller that isn't asking anyone (no confirmation field at all) isn't checked.
  fakeDatabase(weddingScenario("APPROVED"));
  await createPlanVersionWithAssignments("w", generateInput(undefined));
  assert.ok(replacedCurrent());
});

test("TS-237: Restore on an approved plan needs that version confirmed too", async () => {
  fakeDatabase(weddingScenario("APPROVED"));
  await assert.rejects(
    restorePlanVersion("v0", "w", "owner", { mayReplaceApproved: true, replacesApprovedVersionId: null }),
    (err: unknown) => err instanceof ApprovedPlanNotConfirmedError && err.approvedVersionId === "v1"
  );
  assert.ok(!replacedCurrent());
  assert.ok(!committed());

  fakeDatabase(weddingScenario("APPROVED"));
  // Confirmed: it gets past the check and replaces the current plan (the stand-in database may
  // stop it later on; only the replacement matters here).
  await restorePlanVersion("v0", "w", "owner", { mayReplaceApproved: true, replacesApprovedVersionId: "v1" }).catch(
    (err: unknown) => assert.ok(!(err instanceof ApprovedPlanNotConfirmedError), String(err))
  );
  assert.ok(replacedCurrent());

  fakeDatabase(weddingScenario("APPROVED"));
  await restorePlanVersion("v0", "w", "collab", { mayReplaceApproved: false, replacesApprovedVersionId: null }).catch(
    (err: unknown) => assert.ok(!(err instanceof ApprovedPlanNotConfirmedError), String(err))
  );
  assert.ok(!replacedCurrent(), "someone who can't replace it gets a comparison draft, unasked");
});

test("TS-237: the refusal is a 409 the Plan tab recognises, with the approved version's id", async () => {
  const res = approvedPlanNotConfirmedResponse(new ApprovedPlanNotConfirmedError("v1"));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: APPROVED_PLAN_NOT_CONFIRMED_MESSAGE,
    code: APPROVED_PLAN_NOT_CONFIRMED,
    approvedVersionId: "v1",
  });
});

test("TS-237: Generate and Restore bodies take the confirmation (an id or null), bounded", () => {
  assert.ok(generatePlanVersionSchema.safeParse({ makeCurrent: true, replacesApprovedVersionId: "v1" }).success);
  assert.ok(generatePlanVersionSchema.safeParse({ replacesApprovedVersionId: null }).success);
  assert.ok(generatePlanVersionSchema.safeParse({}).success);
  assert.ok(restorePlanVersionSchema.safeParse({ replacesApprovedVersionId: "v1" }).success);
  assert.ok(restorePlanVersionSchema.safeParse({}).success);
  assert.equal(restorePlanVersionSchema.safeParse({ replacesApprovedVersionId: "x".repeat(101) }).success, false);
  assert.equal(restorePlanVersionSchema.safeParse({ replacesApprovedVersionId: 7 }).success, false);
});

// --- TS-237 #6: the table re-check's seat order agrees with Generate's ------------------------------

/** Sorts rows the way Postgres would by SEAT_ORDER (each term: alias."column" [DESC]). */
function sortBySeatOrder<T extends Record<string, unknown>>(rows: T[]): T[] {
  const terms = SEAT_ORDER.split(",").map((t) => {
    const m = /^\s*\w+\.("?)(\w+)\1(\s+DESC)?\s*$/.exec(t);
    assert.ok(m, `unexpected SEAT_ORDER term: ${t}`);
    return { column: m[2], desc: !!m[3] };
  });
  const value = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "boolean" ? Number(v) : v) as string | number;
  return [...rows].sort((a, b) => {
    for (const { column, desc } of terms) {
      const x = value(a[column]);
      const y = value(b[column]);
      if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
}

test("TS-237: SEAT_ORDER breaks a same-moment tie by guest id, never by name", () => {
  assert.doesNotMatch(SEAT_ORDER, /lastName|firstName/);
  const at = new Date("2026-10-01T12:00:00.000Z");
  // Seated at the very same moment; names run the opposite way to ids.
  const rows = [
    { id: "g3", isLocked: true, createdAt: at, lastName: "Adams", firstName: "Ann" },
    { id: "g1", isLocked: true, createdAt: at, lastName: "Young", firstName: "Zed" },
    { id: "g2", isLocked: true, createdAt: at, lastName: "Moss", firstName: "Max" },
  ];
  assert.deepEqual(sortBySeatOrder(rows).map((r) => r.id), ["g1", "g2", "g3"]);
});

test("TS-237: with identical seating times, the table re-check and Generate keep the same locked guests", () => {
  const at = new Date("2026-10-01T12:00:00.000Z");
  // Three locked guests at a locked table that now seats two. Names run opposite to ids.
  const seats = [
    { id: "g3", isLocked: true, createdAt: at, lastName: "Adams", firstName: "Ann" },
    { id: "g1", isLocked: true, createdAt: at, lastName: "Young", firstName: "Zed" },
    { id: "g2", isLocked: true, createdAt: at, lastName: "Moss", firstName: "Max" },
  ];
  // The re-check keeps whoever comes first in SEAT_ORDER while there's room.
  const recheckKeeps = sortBySeatOrder(seats).slice(0, 2).map((r) => r.id).sort();

  // Generate: seat order as getLatestAssignmentsForWedding ranks it (seated time, then guest id),
  // and guests in the guest list's order (last name, first name).
  const rank = new Map([...seats].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s, i) => [s.id, i + 1]));
  const byName = [...seats].sort((a, b) => a.lastName.localeCompare(b.lastName));
  const plan = generateSeatingPlan(
    byName.map((s) => ({
      id: s.id,
      name: `${s.firstName} ${s.lastName}`,
      headcount: 1,
      requiresAccessibleTable: false,
      isLocked: true,
      currentTableId: "T1",
      currentSeatOrder: rank.get(s.id)!,
      side: "BOTH" as const,
      tier: "OTHER" as const,
      ageCategory: "ADULT" as const,
    })),
    [],
    [{ id: "T1", label: "Head", capacity: 2, isRestricted: false, isAccessible: false, isLocked: true, singleSideOnly: false }]
  );
  const generateKeeps = plan.assignments.filter((a) => a.tableId === "T1").map((a) => a.guestId).sort();
  assert.deepEqual(recheckKeeps, ["g1", "g2"]);
  assert.deepEqual(generateKeeps, recheckKeeps);
});

// --- TS-243 #5: plan-version labels follow the text rules -------------------------------------------

test("TS-243: a plan label refuses a NUL, a right-to-left override and a line break", () => {
  for (const label of ["Final\u0000", "Final ‮gnp.exe", "Final\nplan", "Final\r\nplan"]) {
    assert.equal(setPlanVersionLabelSchema.safeParse({ label }).success, false, JSON.stringify(label));
  }
});

test("TS-243: a plan label is trimmed, held to its limit, and empty still clears it", () => {
  const ok = setPlanVersionLabelSchema.safeParse({ label: "  Post-RSVP final  ", expectedRevision: 2 });
  assert.ok(ok.success);
  assert.equal(ok.data.label, "Post-RSVP final");
  const cleared = setPlanVersionLabelSchema.safeParse({ label: "" });
  assert.ok(cleared.success);
  assert.equal(cleared.data.label, "");
  assert.equal(setPlanVersionLabelSchema.safeParse({ label: "x".repeat(101) }).success, false);
  assert.ok(setPlanVersionLabelSchema.safeParse({ label: "x".repeat(100) }).success);
});
