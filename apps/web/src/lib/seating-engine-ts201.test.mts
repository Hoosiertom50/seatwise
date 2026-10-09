// TS-201: unit tests for the seating engine (packages/shared/src/seating-engine.ts) -- accessible
// seats stay with the guests who need them, must-sit partners pinned to different tables come out
// the same whatever the guest-list order ("locked table wins"), the repair can move two groups,
// and a huge "must not sit together" list can't make Generate slow.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSeatingPlan,
  type EngineGuest,
  type EngineRelationship,
  type EngineTable,
} from "../../../../packages/shared/src/seating-engine";

const guest = (id: string, extra: Partial<EngineGuest> = {}): EngineGuest => ({
  id,
  name: id,
  headcount: 1,
  requiresAccessibleTable: false,
  isLocked: false,
  currentTableId: null,
  side: "BOTH",
  tier: "OTHER",
  ageCategory: "ADULT",
  requiredTableId: null,
  ...extra,
});

const table = (id: string, capacity: number, extra: Partial<EngineTable> = {}): EngineTable => ({
  id,
  label: id,
  capacity,
  isRestricted: false,
  isAccessible: false,
  isLocked: false,
  singleSideOnly: false,
  purposeCriterion: null,
  ...extra,
});

const tableOf = (result: ReturnType<typeof generateSeatingPlan>, guestId: string) =>
  result.assignments.find((a) => a.guestId === guestId)?.tableId ?? null;

// Runs the same wedding with the guest list in the given order and reversed, checks both plans
// match (seats, unseated guests and warnings), and returns one of them.
function bothOrders(guests: EngineGuest[], rels: EngineRelationship[], tables: EngineTable[]) {
  const a = generateSeatingPlan(guests, rels, tables);
  const b = generateSeatingPlan([...guests].reverse(), rels, tables);
  const norm = (r: typeof a) => ({
    seats: r.assignments.map((x) => `${x.guestId}@${x.tableId}`).sort(),
    unseated: [...r.unassignedGuestIds].sort(),
    warnings: [...r.warnings].sort(),
  });
  assert.deepEqual(norm(b), norm(a), "the plan depends on guest-list order");
  return a;
}

// The review's repro: before, the largest-first retry seated the family of 4 at the only
// accessible table (it seats more people) and left the wheelchair user unseated.
test("the only accessible table goes to the guest who needs it, even if another plan seats more people", () => {
  const result = generateSeatingPlan(
    [guest("Family", { headcount: 4 }), guest("Wheel", { requiresAccessibleTable: true })],
    [],
    [table("A", 4, { isAccessible: true })]
  );
  assert.equal(tableOf(result, "Wheel"), "A");
  assert.deepEqual(result.unassignedGuestIds, ["Family"]);
  assert.deepEqual(result.warnings, ["Couldn't seat guest Family — no table has enough remaining capacity."]);
});

test("a party that doesn't need it still gets the accessible table when that leaves nobody who needs it unseated", () => {
  const result = generateSeatingPlan(
    [guest("Family", { headcount: 4 }), guest("Wheel", { requiresAccessibleTable: true })],
    [],
    [table("A", 4, { isAccessible: true }), table("B", 1, { isAccessible: true })]
  );
  assert.equal(result.isComplete, true);
  assert.equal(tableOf(result, "Family"), "A");
  assert.equal(tableOf(result, "Wheel"), "B");
});

// Ticket item 1 (Tom's decision, "locked table wins"): Ann is locked and sits at the locked table
// L; Bob is locked to the unlocked table T. Before, the outcome depended on which name came first.
test("a locked guest at a locked table keeps it; a partner locked elsewhere is left unseated, in either order", () => {
  const result = bothOrders(
    [guest("Ann", { isLocked: true, currentTableId: "L" }), guest("Bob", { isLocked: true, currentTableId: "T" })],
    [{ guestAId: "Ann", guestBId: "Bob", type: "MUST_SIT_TOGETHER" }],
    [table("L", 4, { isLocked: true }), table("T", 4)]
  );
  assert.equal(tableOf(result, "Ann"), "L");
  assert.equal(tableOf(result, "Bob"), null);
  assert.deepEqual(result.warnings, [
    `Couldn't seat guest Bob — they're locked to "T", but they must sit with Ann, who is at the locked table "L". Unlock "L" or move them together.`,
  ]);
});

// Ticket item 2: partners at two different locked tables -- the lower table id wins whatever the
// order, and the warning names the unseated guest's own locked table.
test("partners at two different locked tables: the same one keeps their seat in either order", () => {
  const result = bothOrders(
    [guest("Zed", { currentTableId: "L1" }), guest("Amy", { currentTableId: "L2" })],
    [{ guestAId: "Zed", guestBId: "Amy", type: "MUST_SIT_TOGETHER" }],
    [table("L2", 4, { isLocked: true }), table("L1", 4, { isLocked: true }), table("T1", 4)]
  );
  assert.equal(tableOf(result, "Zed"), "L1");
  assert.equal(tableOf(result, "Amy"), null);
  assert.match(result.warnings.join("\n"), /Couldn't seat guest Amy — they sat at the locked table "L2", but they must sit with Zed/);
});

test("a guest's own lock at a locked table wins over a partner who only sits at another locked table", () => {
  const result = bothOrders(
    [guest("A", { currentTableId: "L1" }), guest("B", { isLocked: true, currentTableId: "L2" })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("L1", 4, { isLocked: true }), table("L2", 4, { isLocked: true })]
  );
  assert.equal(tableOf(result, "B"), "L2");
  assert.equal(tableOf(result, "A"), null);
});

test("two partners locked to different unlocked tables sit together at the lower table id, in either order", () => {
  const result = bothOrders(
    [guest("A", { isLocked: true, currentTableId: "T2" }), guest("B", { isLocked: true, currentTableId: "T1" })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("T1", 4), table("T2", 4)]
  );
  assert.equal(tableOf(result, "A"), "T1");
  assert.equal(tableOf(result, "B"), "T1");
  assert.deepEqual(result.warnings, [`Guest A is locked to "T2", but they must sit with B, so they were seated at "T1" instead.`]);
});

// Ticket item 3: a complete plan needs two groups to swap tables (g0 to t1, g2 to t0), which the
// one-move repair couldn't find.
test("the repair can move two groups to seat everyone", () => {
  const guests = [guest("g0"), guest("g1"), guest("g2", { headcount: 2 })];
  const rels: EngineRelationship[] = [
    { guestAId: "g0", guestBId: "g1", type: "MUST_NOT_SIT_TOGETHER" },
    { guestAId: "g2", guestBId: "g0", type: "MUST_NOT_SIT_TOGETHER" },
  ];
  const tables = [table("t0", 7), table("t1", 2)];
  const result = generateSeatingPlan(guests, rels, tables);
  assert.equal(result.isComplete, true);
  assert.equal(tableOf(result, "g0"), "t1");
  assert.equal(tableOf(result, "g1"), "t0");
  assert.equal(tableOf(result, "g2"), "t0");
  assert.deepEqual(result.warnings, []);
  // Without the repair, g1 is left unseated.
  const plain = generateSeatingPlan(guests, rels, tables, "BALANCED_MIX", { repair: false });
  assert.deepEqual(plain.unassignedGuestIds, ["g1"]);
});

// The repair's budget counts work done (including comparing guests against must-not lists), so a
// huge rule list can't make Generate slow. Before, this took over 2 seconds.
// TS-256: a fixed "under 2 seconds" failed once on a busy machine (the run normally takes ~0.2 s).
// Load slows every run on the machine alike, so this compares against a baseline timed right
// alongside it: the same 800 guests with a tenth of the rules. Work that grows in step with the rule
// list keeps the ratio near 10x or below (about 4x today); the old engine's blow-up made it about
// 37x (~6 s against ~0.16 s). Runs alternate and the median of five is used, so one stall doesn't
// decide it. The loose absolute cap only catches a hang.
test("800 guests with 300,000 must-not rules still generate quickly", () => {
  let seed = 201;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const guests = Array.from({ length: 800 }, (_, i) =>
    guest(`g${i}`, { headcount: 1 + Math.floor(rnd() * 3), requiresAccessibleTable: rnd() < 0.05 })
  );
  const tables = Array.from({ length: 100 }, (_, i) => table(`t${i}`, 10, { isAccessible: i < 10 }));
  // 300,000 of the 319,600 possible pairs, skipping a fixed pattern of the rest.
  const rels: EngineRelationship[] = [];
  for (let a = 0; a < 800 && rels.length < 300_000; a++) {
    for (let b = a + 1; b < 800 && rels.length < 300_000; b++) {
      if ((a * 31 + b * 17) % 20 === 0) continue;
      rels.push({ guestAId: `g${a}`, guestBId: `g${b}`, type: "MUST_NOT_SIT_TOGETHER" });
    }
  }
  assert.equal(rels.length, 300_000);
  // TS-256: the baseline -- the same guests and tables with the first tenth of the rules.
  const baselineRels = rels.slice(0, 30_000);

  const timed = (r: EngineRelationship[]) => {
    const started = performance.now();
    const result = generateSeatingPlan(guests, r, tables);
    return { ms: performance.now() - started, result };
  };
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  timed(baselineRels); // warm-up, so compiling the engine isn't counted against either side
  const full: number[] = [];
  const base: number[] = [];
  let result = timed(rels).result;
  for (let i = 0; i < 5; i++) {
    base.push(timed(baselineRels).ms);
    const run = timed(rels);
    full.push(run.ms);
    result = run.result;
  }
  const fullMs = median(full);
  const baseMs = Math.max(median(base), 1);
  const detail = `300,000 rules: ${Math.round(fullMs)} ms; 30,000 rules: ${Math.round(baseMs)} ms`;
  assert.ok(fullMs / baseMs < 15, `grew much faster than the rule list -- ${detail}`);
  assert.ok(fullMs < 10_000, `took far too long -- ${detail}`);
  assert.ok(result.unassignedGuestIds.length > 0);
  const seatedAt = new Map(result.assignments.map((a) => [a.guestId, a.tableId]));
  for (const r of rels) {
    const a = seatedAt.get(r.guestAId);
    assert.ok(!a || a !== seatedAt.get(r.guestBId), "must-not broken");
  }
});
