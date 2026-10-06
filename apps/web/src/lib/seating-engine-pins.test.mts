// TS-173: unit tests for how the seating engine (packages/shared/src/seating-engine.ts) handles
// guests required at a Restricted table. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSeatingPlan, type EngineGuest, type EngineTable } from "../../../../packages/shared/src/seating-engine";

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

const table = (id: string, extra: Partial<EngineTable> = {}): EngineTable => ({
  id,
  label: id,
  capacity: 8,
  isRestricted: false,
  isAccessible: false,
  isLocked: false,
  singleSideOnly: false,
  purposeCriterion: null,
  ...extra,
});

const tableOf = (result: ReturnType<typeof generateSeatingPlan>, guestId: string) =>
  result.assignments.find((a) => a.guestId === guestId)?.tableId ?? null;

test("a group whose members are all on the list is seated at the Restricted table", () => {
  const result = generateSeatingPlan(
    [guest("A", { requiredTableId: "VIP" }), guest("B", { requiredTableId: "VIP" })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("VIP", { isRestricted: true }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "VIP");
  assert.equal(tableOf(result, "B"), "VIP");
  assert.equal(result.isComplete, true);
});

test("a group with an unlisted member is left unassigned, never seated at the Restricted table", () => {
  const result = generateSeatingPlan(
    [guest("A", { requiredTableId: "VIP" }), guest("B")],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("VIP", { isRestricted: true }), table("T1")]
  );
  assert.deepEqual(result.assignments, []);
  assert.deepEqual([...result.unassignedGuestIds].sort(), ["A", "B"]);
  assert.match(result.warnings.join("\n"), /not all of them are on "VIP"'s required list/);
});

test("a group required at two different tables is left unassigned", () => {
  const result = generateSeatingPlan(
    [guest("A", { requiredTableId: "VIP" }), guest("B", { requiredTableId: "Head" })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("VIP", { isRestricted: true }), table("Head", { isRestricted: true }), table("T1")]
  );
  assert.deepEqual(result.assignments, []);
  assert.match(result.warnings.join("\n"), /required at different tables/);
});

test("a required guest whose table has no room is left unassigned, not seated elsewhere", () => {
  const result = generateSeatingPlan(
    [guest("A", { requiredTableId: "VIP", headcount: 3 })],
    [],
    [table("VIP", { isRestricted: true, capacity: 2 }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), null);
  assert.deepEqual(result.unassignedGuestIds, ["A"]);
  assert.match(result.warnings.join("\n"), /required at "VIP", and it has no room/);
});

test("a locked guest whose table is gone is still seated automatically", () => {
  const result = generateSeatingPlan(
    [guest("A", { isLocked: true, currentTableId: "Gone" })],
    [],
    [table("T1")]
  );
  assert.equal(tableOf(result, "A"), "T1");
  assert.match(result.warnings.join("\n"), /locked to a table that no longer exists/);
});

// TS-177 (Tom's decision): a locked table keeps the people already at it and seats nobody new.
test("everyone seated at a locked table stays there, and nobody new is seated there", () => {
  const result = generateSeatingPlan(
    [
      guest("A", { currentTableId: "Locked" }),
      guest("B", { currentTableId: "Locked" }),
      guest("C", { currentTableId: "T1" }),
      guest("D"),
    ],
    [],
    [table("Locked", { isLocked: true }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "Locked");
  assert.equal(tableOf(result, "B"), "Locked");
  assert.equal(tableOf(result, "C"), "T1");
  assert.equal(tableOf(result, "D"), "T1");
  assert.equal(result.isComplete, true);
  assert.doesNotMatch(result.warnings.join("\n"), /locked to/);
});

test("a must-sit-together partner of someone at a locked table joins them there", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "Locked" }), guest("B")],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("Locked", { isLocked: true }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "Locked");
  assert.equal(tableOf(result, "B"), "Locked");
});

test("a required-table pin still wins over sitting at a locked table", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "Locked", requiredTableId: "VIP" })],
    [],
    [table("Locked", { isLocked: true }), table("VIP", { isRestricted: true }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "VIP");
});

test("a locked table that shrank keeps who still fits; the rest are seated automatically, with a warning", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "Locked", headcount: 2 }), guest("B", { currentTableId: "Locked", headcount: 2 })],
    [],
    [table("Locked", { isLocked: true, capacity: 3 }), table("T1")]
  );
  assert.deepEqual(["A", "B"].map((id) => tableOf(result, id)).sort(), ["Locked", "T1"]);
  assert.match(result.warnings.join("\n"), /locked to "Locked", but that's no longer possible — seated automatically instead/);
  assert.equal(result.isComplete, true);
});

test("someone at a locked table who now needs an accessible seat is moved, with a warning", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "Locked", requiresAccessibleTable: true })],
    [],
    [table("Locked", { isLocked: true }), table("Ramp", { isAccessible: true })]
  );
  assert.equal(tableOf(result, "A"), "Ramp");
  assert.match(result.warnings.join("\n"), /locked to "Locked", but that's no longer possible/);
});

test("guests at two different locked tables who must sit together are kept together at the first one", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "L1" }), guest("B", { currentTableId: "L2" })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("L1", { isLocked: true }), table("L2", { isLocked: true }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "L1");
  assert.equal(tableOf(result, "B"), "L1");
});

// TS-181: pins are placed in passes -- required, then guests' own locks, then people kept at a
// locked table -- and a lock that can't be kept is only seated elsewhere after every pin is tried.
test("a lock that can't be kept doesn't take the seat another guest is locked to", () => {
  const result = generateSeatingPlan(
    // A comes first in the list and its table is gone; B is locked to T1, which has one seat.
    [guest("A", { isLocked: true, currentTableId: "Gone" }), guest("B", { isLocked: true, currentTableId: "T1" })],
    [],
    [table("T1", { capacity: 1 }), table("T2", { capacity: 1 })]
  );
  assert.equal(tableOf(result, "B"), "T1");
  assert.equal(tableOf(result, "A"), "T2");
  assert.doesNotMatch(result.warnings.join("\n"), /Guest B is locked to/);
  assert.equal(result.isComplete, true);
});

test("a guest's own lock is kept before someone who's only kept by a locked table", () => {
  const result = generateSeatingPlan(
    // Both sit at the locked table, which now has room for only one of them; A comes first.
    [
      guest("A", { currentTableId: "L", headcount: 2 }),
      guest("B", { currentTableId: "L", headcount: 2, isLocked: true }),
    ],
    [],
    [table("L", { isLocked: true, capacity: 2 }), table("T1")]
  );
  assert.equal(tableOf(result, "B"), "L");
  assert.equal(tableOf(result, "A"), "T1");
  assert.match(result.warnings.join("\n"), /Guest A is locked to "L", but that's no longer possible/);
});

test("among people kept by a locked table, a group with a locked guest goes first", () => {
  const result = generateSeatingPlan(
    [
      guest("D", { currentTableId: "L", headcount: 2 }),
      guest("A", { currentTableId: "L", headcount: 2 }),
      // C is locked but has no seat yet; their must-sit-together partner A is at the locked table.
      guest("C", { isLocked: true }),
    ],
    [{ guestAId: "A", guestBId: "C", type: "MUST_SIT_TOGETHER" }],
    [table("L", { isLocked: true, capacity: 3 }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "L");
  assert.equal(tableOf(result, "C"), "L");
  assert.equal(tableOf(result, "D"), "T1");
});

test("a required guest keeps their Restricted table, and a lock that can't be kept waits its turn", () => {
  const result = generateSeatingPlan(
    [
      guest("A", { isLocked: true, currentTableId: "Gone" }),
      guest("R", { requiredTableId: "VIP" }),
      guest("B", { isLocked: true, currentTableId: "T1" }),
    ],
    [],
    [table("VIP", { isRestricted: true, capacity: 1 }), table("T1", { capacity: 1 }), table("T2", { capacity: 1 })]
  );
  assert.equal(tableOf(result, "R"), "VIP");
  assert.equal(tableOf(result, "B"), "T1");
  assert.equal(tableOf(result, "A"), "T2");
});
