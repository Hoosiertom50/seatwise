// TS-236: unit tests for the seating engine (packages/shared/src/seating-engine.ts) -- a repaired
// plan's "avoid" warnings say the repair moved someone (not "best fit overall"), the repair seats a
// moved group at the table with the fewest "avoid" conflicts, "most need first" puts the smaller
// party first on a tie, and which locked guests keep a too-small table never depends on names.
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

const rel = (a: string, b: string, type: EngineRelationship["type"]): EngineRelationship => ({
  guestAId: a,
  guestBId: b,
  type,
});

const tableOf = (result: ReturnType<typeof generateSeatingPlan>, guestId: string) =>
  result.assignments.find((a) => a.guestId === guestId)?.tableId ?? null;

// Item 1, the review's repro: the repair seats Cat by moving Dan next to Ben, whom he avoids. The
// warnings used to say "it was the best fit overall" -- not true, the repair put him there.
test("a repaired plan's avoid warnings say the repair moved them, not best fit overall", () => {
  const guests = [
    guest("g0", { name: "Ann Adams" }),
    guest("g1", { name: "Ben Baker" }),
    guest("g2", { name: "Cat Clark" }),
    guest("g3", { name: "Dan Davis", headcount: 2 }),
  ];
  const rels = [
    rel("g0", "g1", "AVOID"),
    rel("g3", "g2", "AVOID"),
    rel("g3", "g1", "AVOID"),
    rel("g2", "g0", "MUST_NOT_SIT_TOGETHER"),
  ];
  const tables = [table("Table 1", 2), table("Table 2", 4)];
  const result = generateSeatingPlan(guests, rels, tables);
  assert.equal(result.isComplete, true);
  const avoidWarnings = result.warnings.filter((w) => w.includes('"avoid" preference'));
  assert.ok(avoidWarnings.length > 0);
  for (const w of avoidWarnings) {
    assert.doesNotMatch(w, /best fit overall|no other table had room/);
    assert.match(w, /so everyone could be seated/);
  }
  const danBen = avoidWarnings.find((w) => w.includes("Dan Davis") && w.includes("Ben Baker"));
  assert.match(danBen ?? "", /one of them was moved there so everyone could be seated/);
});

// Item 1, the repair's own pick: to seat X (who can't sit with P or R), M gives X its seat and must
// move. T3 and T4 both have room for M; T3 comes first but seats P, whom M avoids. It used to take
// the first table with room (T3); now it takes the one with no "avoid" conflict.
test("the repair moves a group to the table with the fewest avoid conflicts", () => {
  const guests = [
    guest("M", { headcount: 2 }),
    guest("Q", { headcount: 2 }),
    guest("P"),
    guest("R"),
    guest("X"),
  ];
  const rels = [
    rel("M", "P", "AVOID"),
    rel("R", "P", "MUST_NOT_SIT_TOGETHER"),
    rel("X", "P", "MUST_NOT_SIT_TOGETHER"),
    rel("X", "R", "MUST_NOT_SIT_TOGETHER"),
  ];
  const tables = [table("T1", 2), table("T2", 2), table("T3", 3), table("T4", 3)];
  // Without the repair, X is left unseated -- so the plan below really came from the repair.
  assert.deepEqual(generateSeatingPlan(guests, rels, tables, "BALANCED_MIX", { repair: false }).unassignedGuestIds, ["X"]);
  const result = generateSeatingPlan(guests, rels, tables);
  assert.equal(result.isComplete, true);
  assert.equal(tableOf(result, "X"), "T1");
  assert.equal(tableOf(result, "M"), "T4");
  assert.notEqual(tableOf(result, "M"), tableOf(result, "P"));
  assert.equal(result.warnings.some((w) => w.includes('"avoid"')), false);
  assert.equal(result.scoreReport?.preferences.every((p) => p.satisfied), true);
});

// Item 2, the review's repro: a couple where only Ann needs the accessible table, and two single
// guests who both need it, tie on "most need first" (1 each). The bigger party used to go first,
// leaving 2 people who need the table without it instead of 1.
test("on a tie for most need, the smaller party gets the accessible seats first", () => {
  const guests = [
    guest("Ann", { requiresAccessibleTable: true }),
    guest("Carl"),
    guest("Dee", { headcount: 4, requiresAccessibleTable: true }),
    guest("Eve", { requiresAccessibleTable: true }),
    guest("Fay", { requiresAccessibleTable: true }),
    guest("Gus", { headcount: 6 }),
  ];
  const rels = [rel("Ann", "Carl", "MUST_SIT_TOGETHER")];
  const tables = [table("Acc", 6, { isAccessible: true }), table("T2", 6)];
  for (const list of [guests, [...guests].reverse()]) {
    const result = generateSeatingPlan(list, rels, tables);
    assert.equal(tableOf(result, "Dee"), "Acc");
    assert.equal(tableOf(result, "Eve"), "Acc");
    assert.equal(tableOf(result, "Fay"), "Acc");
    assert.deepEqual([...result.unassignedGuestIds].sort(), ["Ann", "Carl"]);
  }
});

// Item 3, the review's repro: Table 1 shrank to 2 seats and three locked guests are there. Who was
// moved used to depend on last names (the guest list is sorted by them), so renaming Amy Zimmer to
// Amy Abbott moved someone else.
const lockedAt = (id: string, name: string, tableId: string, extra: Partial<EngineGuest> = {}) =>
  guest(id, { name, isLocked: true, currentTableId: tableId, ...extra });
// The generate route passes guests sorted by last name, then first name.
const lastFirst = (g: EngineGuest) => g.name.split(" ").reverse().join(" ");
const byName = (list: EngineGuest[]) =>
  [...list].sort((a, b) => (lastFirst(a) < lastFirst(b) ? -1 : lastFirst(a) > lastFirst(b) ? 1 : 0));

test("renaming a locked guest never changes who keeps a table that's too small", () => {
  const tables = [table("Table 1", 2), table("Table 2", 8)];
  const plan = (amyName: string) =>
    generateSeatingPlan(
      byName([lockedAt("g1", amyName, "Table 1"), lockedAt("g2", "Ben Young", "Table 1"), lockedAt("g3", "Cal Xu", "Table 1")]),
      [],
      tables
    );
  const before = plan("Amy Zimmer");
  const after = plan("Amy Abbott");
  for (const id of ["g1", "g2", "g3"]) assert.equal(tableOf(after, id), tableOf(before, id));
  // With no seating order given, guest id decides.
  assert.equal(tableOf(before, "g1"), "Table 1");
  assert.equal(tableOf(before, "g2"), "Table 1");
  assert.equal(tableOf(before, "g3"), "Table 2");
});

test("locked guests keep a too-small table in the order they were seated there", () => {
  const tables = [table("Table 1", 2), table("Table 2", 8)];
  const guests = [
    lockedAt("g1", "Amy Abbott", "Table 1", { currentSeatOrder: 30 }),
    lockedAt("g2", "Ben Young", "Table 1", { currentSeatOrder: 10 }),
    lockedAt("g3", "Cal Xu", "Table 1", { currentSeatOrder: 20 }),
  ];
  for (const list of [guests, [...guests].reverse(), byName(guests)]) {
    const result = generateSeatingPlan(list, [], tables);
    assert.equal(tableOf(result, "g2"), "Table 1");
    assert.equal(tableOf(result, "g3"), "Table 1");
    assert.equal(tableOf(result, "g1"), "Table 2");
    assert.match(result.warnings.join("\n"), /Guest Amy Abbott is locked to "Table 1", but that's no longer possible/);
  }
});

// Item 3 for a locked *table* (TS-177): everyone at it is kept like a locked guest; a guest's own
// lock still goes first, then seating order -- never names.
test("at a locked table that shrank, a locked guest goes first, then seating order", () => {
  const tables = [table("Head", 2, { isLocked: true }), table("T2", 8)];
  const guests = [
    guest("g1", { name: "Amy Abbott", currentTableId: "Head", currentSeatOrder: 1 }),
    guest("g2", { name: "Ben Young", currentTableId: "Head", currentSeatOrder: 3 }),
    guest("g3", { name: "Cal Xu", currentTableId: "Head", currentSeatOrder: 2 }),
    guest("g4", { name: "Dee Ames", currentTableId: "Head", currentSeatOrder: 4, isLocked: true }),
  ];
  for (const list of [guests, [...guests].reverse(), byName(guests)]) {
    const result = generateSeatingPlan(list, [], tables);
    assert.equal(tableOf(result, "g4"), "Head");
    assert.equal(tableOf(result, "g1"), "Head");
    assert.equal(tableOf(result, "g2"), "T2");
    assert.equal(tableOf(result, "g3"), "T2");
  }
});

test("the same wedding gives the same plan every time, whatever the guest-list order", () => {
  const tables = [table("A", 3, { isAccessible: true }), table("B", 2, { isLocked: true }), table("C", 4)];
  const guests = [
    guest("g1", { isLocked: true, currentTableId: "A", currentSeatOrder: 2 }),
    guest("g2", { isLocked: true, currentTableId: "A", currentSeatOrder: 1, headcount: 2 }),
    guest("g3", { isLocked: true, currentTableId: "A", currentSeatOrder: 3, requiresAccessibleTable: true }),
    guest("g4", { currentTableId: "B", currentSeatOrder: 4 }),
    guest("g5", { currentTableId: "B", currentSeatOrder: 5 }),
    guest("g6", { currentTableId: "B", currentSeatOrder: 6 }),
    guest("g7", { headcount: 2 }),
    guest("g8", { requiresAccessibleTable: true }),
  ];
  const rels = [rel("g7", "g8", "AVOID"), rel("g5", "g1", "PREFER_NEAR")];
  const first = generateSeatingPlan(guests, rels, tables);
  const sorted = (r: ReturnType<typeof generateSeatingPlan>) =>
    JSON.stringify([[...r.assignments].sort((a, b) => (a.guestId < b.guestId ? -1 : 1)), [...r.unassignedGuestIds].sort()]);
  for (const list of [guests, [...guests].reverse(), [...guests.slice(4), ...guests.slice(0, 4)]]) {
    assert.equal(sorted(generateSeatingPlan(list, rels, tables)), sorted(first));
  }
});
