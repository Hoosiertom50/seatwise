// TS-226: unit tests for the seating engine (packages/shared/src/seating-engine.ts) -- accessible
// seats go to the groups with the most people who need them, "no other table had room" is only
// said when it's true, and the repair stops early when there are far more guests than seats.
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

// Item 1, the review's repro: a family of 4 with one person who needs the accessible table (Mom)
// used to fill it, leaving Gran (party of 2) and Pop -- 3 people who need it -- unseated.
test("the accessible table goes to the groups with the most people who need it", () => {
  const guests = [
    guest("Dad", { headcount: 2 }),
    guest("Mom", { requiresAccessibleTable: true }),
    guest("Kid"),
    guest("Gran", { headcount: 2, requiresAccessibleTable: true }),
    guest("Pop", { requiresAccessibleTable: true }),
  ];
  const rels: EngineRelationship[] = [
    { guestAId: "Dad", guestBId: "Mom", type: "MUST_SIT_TOGETHER" },
    { guestAId: "Mom", guestBId: "Kid", type: "MUST_SIT_TOGETHER" },
  ];
  const tables = [table("Acc", 4, { isAccessible: true }), table("T2", 8)];
  for (const list of [guests, [...guests].reverse()]) {
    const result = generateSeatingPlan(list, rels, tables);
    assert.equal(tableOf(result, "Gran"), "Acc");
    assert.equal(tableOf(result, "Pop"), "Acc");
    assert.deepEqual([...result.unassignedGuestIds].sort(), ["Dad", "Kid", "Mom"]);
  }
  // The same input always gives the same plan.
  assert.deepEqual(generateSeatingPlan(guests, rels, tables), generateSeatingPlan(guests, rels, tables));
});

// Item 1: the extra order is only kept when it's strictly better -- here the normal order already
// seats everyone, so nothing changes.
test("a plan that already seats everyone who needs the accessible table is unchanged", () => {
  const guests = [
    guest("Big", { headcount: 3, requiresAccessibleTable: true }),
    guest("Pair", { headcount: 2, requiresAccessibleTable: true }),
    guest("Solo", { requiresAccessibleTable: true }),
  ];
  const result = generateSeatingPlan(guests, [], [table("Acc", 6, { isAccessible: true }), table("T2", 4)]);
  assert.equal(result.isComplete, true);
  for (const id of ["Big", "Pair", "Solo"]) assert.equal(tableOf(result, id), "Acc");
});

// Item 2, the review's repro: Ann prefers Bea and avoids Cal; all three sit at T1 while T2 is empty.
test('an "avoid" warning says it was the best fit when another table had room', () => {
  const result = generateSeatingPlan(
    // TS-244: singles go in guest-id order, so Cal's id sorts before Ann's to seat Cal first.
    [guest("g1", { name: "Bea", headcount: 2 }), guest("g2", { name: "Cal" }), guest("g3", { name: "Ann" })],
    [
      { guestAId: "g3", guestBId: "g1", type: "PREFER_NEAR" },
      { guestAId: "g3", guestBId: "g2", type: "AVOID" },
    ],
    [table("T1", 8), table("T2", 8)]
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Ann and Cal were seated at the same table despite an "avoid" preference/);
  assert.match(result.warnings[0], /it was the best fit overall, weighing everyone's seating preferences/);
  assert.doesNotMatch(result.warnings[0], /no other table had room/);
});

test('an "avoid" warning still says no other table had room when that is true', () => {
  const result = generateSeatingPlan(
    [guest("Ann"), guest("Cal")],
    [{ guestAId: "Ann", guestBId: "Cal", type: "AVOID" }],
    [table("T1", 2)]
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /"avoid" preference between them — no other table had room/);
});

// Two guests kept at the same table by their locks: the warning names the lock, not room.
test('an "avoid" warning for a locked guest says the lock kept them there', () => {
  const result = generateSeatingPlan(
    [
      guest("Cal", { isLocked: true, currentTableId: "T1" }),
      guest("Ann", { isLocked: true, currentTableId: "T1" }),
    ],
    [{ guestAId: "Ann", guestBId: "Cal", type: "AVOID" }],
    [table("T1", 8), table("T2", 8)]
  );
  assert.equal(result.warnings.length, 1);
  // TS-236: locks are placed by seating order, then guest id (not list order), so Ann goes first
  // and the warning is about Cal, seated second.
  assert.match(result.warnings[0], /Cal is kept at "T1" because of a lock/);
  assert.doesNotMatch(result.warnings[0], /no other table had room|best fit/);
});

// Item 3, the review's repro: under Fully Mixed the opposite-side bonus put Bri at the Groom-only
// Head table while T2 was empty.
test("a Single-Side-Only warning says it was the best fit when another table had room", () => {
  const result = generateSeatingPlan(
    [guest("Gus", { side: "GROOM", headcount: 2 }), guest("Bri", { side: "BRIDE" })],
    [],
    [table("Head", 8, { singleSideOnly: true }), table("T2", 8)],
    "FULLY_MIXED"
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Bri was seated at "Head" \(Single-Side-Only\) despite being on the other side/);
  assert.match(result.warnings[0], /it was the best fit overall/);
  assert.doesNotMatch(result.warnings[0], /no other table had room/);
});

test("a Single-Side-Only warning still says no other table had room when that is true", () => {
  const result = generateSeatingPlan(
    [
      guest("BrideA", { side: "BRIDE" }),
      guest("BrideB", { side: "BRIDE" }),
      guest("BrideC", { side: "BRIDE" }),
      guest("Groom", { side: "GROOM" }),
    ],
    [],
    [table("Head", 3, { singleSideOnly: true }), table("Side", 1)],
    "KEEP_SEPARATE"
  );
  assert.equal(result.isComplete, true);
  const warning = result.warnings.find((w) => w.includes("Single-Side-Only"));
  assert.ok(warning, "expected a Single-Side-Only warning");
  assert.match(warning, /no other table had room/);
});

// Item 4: with far more guests than seats the repair used to spend its whole work budget twice
// (about 800 ms here); it now stops as soon as no unseated group could fit the free seats.
test("the repair stops early when there are far more guests than seats", () => {
  const guests = Array.from({ length: 300 }, (_, i) => guest(`g${String(i).padStart(3, "0")}`));
  const tables = [table("t0", 50, { isAccessible: true }), table("t1", 50)];
  let best = Infinity;
  let result: ReturnType<typeof generateSeatingPlan> | null = null;
  // Best of several runs, so a busy machine can't make it fail.
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    result = generateSeatingPlan(guests, [], tables);
    best = Math.min(best, performance.now() - started);
  }
  assert.ok(best < 200, `took ${Math.round(best)} ms`);
  assert.equal(result!.unassignedGuestIds.length, 200);
  // Stopping early never seats fewer people than the plain engine.
  const plain = generateSeatingPlan(guests, [], tables, "BALANCED_MIX", { repair: false });
  assert.equal(result!.assignments.length, plain.assignments.length);
});

// Item 4: the early stop only skips groups too big for the free seats -- a smaller one still gets
// the repair. Wheel is seated first at Small, Party1 takes Big, and Party2 only fits once Wheel
// moves to Big; Huge (20) can never fit the 5 free seats, so it's skipped.
test("the repair still seats a group that fits the free seats", () => {
  const guests = [
    guest("Party1", { headcount: 4 }),
    guest("Party2", { headcount: 4 }),
    guest("Wheel", { requiresAccessibleTable: true }),
    guest("Huge", { headcount: 20 }),
  ];
  const tables = [table("Small", 4, { isAccessible: true }), table("Big", 6, { isAccessible: true })];
  const result = generateSeatingPlan(guests, [], tables);
  assert.deepEqual(result.unassignedGuestIds, ["Huge"]);
  assert.equal(tableOf(result, "Wheel"), "Big");
  assert.equal(tableOf(result, "Party2"), "Small");
  const plain = generateSeatingPlan(guests, [], tables, "BALANCED_MIX", { repair: false });
  assert.deepEqual([...plain.unassignedGuestIds].sort(), ["Huge", "Party2"]);
});

// TS-227 (Copilot on PR #104): a locked family whose table was deleted (a failed lock) with one
// person who needs the accessible table used to be placed ahead of every unpinned group, filling the
// only accessible table while three guests who all need it were left unseated.
test("a failed lock with one person needing the accessible table doesn't take it from a group where everyone does", () => {
  const locked = { isLocked: true, currentTableId: "Gone" };
  const guests = [
    guest("Dad", { headcount: 2, ...locked }),
    guest("Mom", { requiresAccessibleTable: true, ...locked }),
    guest("Kid", locked),
    guest("Ann", { requiresAccessibleTable: true }),
    guest("Bo", { requiresAccessibleTable: true }),
    guest("Cy", { requiresAccessibleTable: true }),
  ];
  const rels: EngineRelationship[] = [
    { guestAId: "Dad", guestBId: "Mom", type: "MUST_SIT_TOGETHER" },
    { guestAId: "Mom", guestBId: "Kid", type: "MUST_SIT_TOGETHER" },
    { guestAId: "Ann", guestBId: "Bo", type: "MUST_SIT_TOGETHER" },
    { guestAId: "Bo", guestBId: "Cy", type: "MUST_SIT_TOGETHER" },
  ];
  const tables = [table("Acc", 4, { isAccessible: true }), table("T2", 8)];
  for (const list of [guests, [...guests].reverse()]) {
    const result = generateSeatingPlan(list, rels, tables);
    assert.deepEqual(["Ann", "Bo", "Cy"].map((g) => tableOf(result, g)), ["Acc", "Acc", "Acc"]);
    assert.deepEqual([...result.unassignedGuestIds].sort(), ["Dad", "Kid", "Mom"]);
  }
});
