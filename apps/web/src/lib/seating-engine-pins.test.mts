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
  // TS-188: says plainly that the table was removed.
  assert.match(
    result.warnings.join("\n"),
    /Guest A was locked to a table that's been removed, so they were seated automatically\./
  );
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

// TS-188 (was TS-177's "joins them there"): nobody new is seated at a locked table, not even a
// must-sit-together partner -- the partner is left unseated with a warning saying what to do.
test("a must-sit-together partner of someone at a locked table isn't added there; they're left unseated", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "Locked" }), guest("B")],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("Locked", { isLocked: true }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "Locked");
  assert.equal(tableOf(result, "B"), null);
  assert.deepEqual(result.unassignedGuestIds, ["B"]);
  assert.equal(result.isComplete, false);
  assert.match(
    result.warnings.join("\n"),
    /Couldn't seat guest B — they must sit with A, but A's table "Locked" is locked\. Unlock it or move them together\./
  );
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
  // TS-188: neither is locked themselves, so neither is described as "locked to" the table.
  assert.match(result.warnings.join("\n"), /was at the locked table "Locked", but that's no longer possible — seated automatically instead/);
  assert.doesNotMatch(result.warnings.join("\n"), /locked to/);
  assert.equal(result.isComplete, true);
});

test("someone at a locked table who now needs an accessible seat is moved, with a warning", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "Locked", requiresAccessibleTable: true })],
    [],
    [table("Locked", { isLocked: true }), table("Ramp", { isAccessible: true })]
  );
  assert.equal(tableOf(result, "A"), "Ramp");
  assert.match(result.warnings.join("\n"), /Guest A was at the locked table "Locked", but that's no longer possible/);
});

// TS-188: before, B was moved onto A's locked table. A locked table takes nobody new, so B (who
// can't sit apart from A) is left unseated with a warning instead. TS-201: which of them keeps
// their seat no longer depends on guest-list order (the lower table id wins), and the warning
// names B's own locked table too.
test("guests at two different locked tables who must sit together: the same one keeps their seat in either order, and the other is told about both tables", () => {
  for (const order of [["A", "B"], ["B", "A"]]) {
    const all = { A: guest("A", { currentTableId: "L1" }), B: guest("B", { currentTableId: "L2" }) };
    const result = generateSeatingPlan(
      order.map((id) => all[id as "A" | "B"]),
      [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
      [table("L1", { isLocked: true }), table("L2", { isLocked: true }), table("T1")]
    );
    assert.equal(tableOf(result, "A"), "L1");
    assert.equal(tableOf(result, "B"), null);
    assert.deepEqual(result.warnings, [
      `Couldn't seat guest B — they sat at the locked table "L2", but they must sit with A, who is at the locked table "L1". Unlock "L1" or move them together.`,
    ]);
  }
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
  assert.match(result.warnings.join("\n"), /Guest A was at the locked table "L", but that's no longer possible/);
});

// TS-188 (replaces TS-181's "a group with a locked guest goes first"): before, C (locked, but not
// seated anywhere yet) was brought to the locked table with their partner A and pushed D out.
test("a newcomer to a locked table never pushes out someone already sitting there", () => {
  const result = generateSeatingPlan(
    [
      guest("D", { currentTableId: "L", headcount: 2 }),
      guest("A", { currentTableId: "L", headcount: 2 }),
      // C is locked but has no seat yet; their must-sit-together partner A is at the locked table.
      guest("C", { isLocked: true }),
    ],
    [{ guestAId: "A", guestBId: "C", type: "MUST_SIT_TOGETHER" }],
    [table("L", { isLocked: true, capacity: 4 }), table("T1")]
  );
  assert.equal(tableOf(result, "A"), "L");
  assert.equal(tableOf(result, "D"), "L");
  assert.equal(tableOf(result, "C"), null);
  assert.deepEqual(result.unassignedGuestIds, ["C"]);
  assert.match(result.warnings.join("\n"), /Couldn't seat guest C — they must sit with A, but A's table "L" is locked/);
});

test("a must-sit partner who'd be new at a full locked table doesn't move anyone off it", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "L" }), guest("X", { currentTableId: "L" }), guest("B")],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("L", { isLocked: true, capacity: 2 }), table("T2")]
  );
  assert.equal(tableOf(result, "A"), "L");
  assert.equal(tableOf(result, "X"), "L");
  assert.equal(tableOf(result, "B"), null);
  assert.doesNotMatch(result.warnings.join("\n"), /Guest X/);
});

// TS-188: accessible tables are kept for the guests who need them.
test("a party that doesn't need an accessible table leaves it for one that does", () => {
  const result = generateSeatingPlan(
    [guest("Party", { headcount: 4 }), guest("Wheel", { requiresAccessibleTable: true })],
    [],
    [table("Ramp", { capacity: 4, isAccessible: true }), table("T2", { capacity: 4 })]
  );
  assert.equal(tableOf(result, "Wheel"), "Ramp");
  assert.equal(tableOf(result, "Party"), "T2");
  assert.equal(result.isComplete, true);
});

test("a lock that can't be kept doesn't take the only accessible table from someone who needs it", () => {
  const result = generateSeatingPlan(
    [
      guest("Lk", { isLocked: true, currentTableId: "Gone", headcount: 4 }),
      guest("Wheel", { requiresAccessibleTable: true, headcount: 4 }),
    ],
    [],
    [table("Ramp", { capacity: 4, isAccessible: true }), table("T2", { capacity: 4 })]
  );
  assert.equal(tableOf(result, "Wheel"), "Ramp");
  assert.equal(tableOf(result, "Lk"), "T2");
  assert.equal(result.isComplete, true);
});

test("a guest who doesn't need it still sits at an accessible table when it's the only one with room", () => {
  const result = generateSeatingPlan(
    [guest("A", { headcount: 6 })],
    [],
    [table("Ramp", { capacity: 8, isAccessible: true }), table("T2", { capacity: 4 })]
  );
  assert.equal(tableOf(result, "A"), "Ramp");
});

// TS-188: when a pinned group lands somewhere other than a member's own lock or locked-table seat.
test("a locked guest moved to stay with their must-sit partner is told so", () => {
  const result = generateSeatingPlan(
    [guest("A", { isLocked: true, currentTableId: "T1" }), guest("B", { isLocked: true, currentTableId: "T2" })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("T1"), table("T2")]
  );
  assert.equal(tableOf(result, "A"), "T1");
  assert.equal(tableOf(result, "B"), "T1");
  assert.match(
    result.warnings.join("\n"),
    /Guest B is locked to "T2", but they must sit with A, so they were seated at "T1" instead\./
  );
});

// TS-201 (Tom's decision, "locked table wins"): before, A was moved off the locked table to sit
// with B. Now A stays at the locked table and B is left unseated, told about both tables.
test("someone at a locked table stays there; their partner locked to another table is left unseated and told why", () => {
  const result = generateSeatingPlan(
    [guest("A", { currentTableId: "L" }), guest("B", { isLocked: true, currentTableId: "T2" })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("L", { isLocked: true }), table("T2")]
  );
  assert.equal(tableOf(result, "A"), "L");
  assert.equal(tableOf(result, "B"), null);
  assert.deepEqual(result.warnings, [
    `Couldn't seat guest B — they're locked to "T2", but they must sit with A, who is at the locked table "L". Unlock "L" or move them together.`,
  ]);
});

// TS-188: the reason given when nobody can be seated says what's really wrong.
test("when every table is locked or restricted, the warning says so", () => {
  const result = generateSeatingPlan(
    [guest("A")],
    [],
    [table("L", { isLocked: true }), table("VIP", { isRestricted: true })]
  );
  assert.match(result.warnings.join("\n"), /Couldn't seat guest A — every table is locked or restricted\./);
});

test("a party bigger than any table is told so", () => {
  const result = generateSeatingPlan(
    [guest("A", { headcount: 3 }), guest("B", { headcount: 3 })],
    [{ guestAId: "A", guestBId: "B", type: "MUST_SIT_TOGETHER" }],
    [table("T1", { capacity: 5 }), table("T2", { capacity: 5 })]
  );
  assert.match(result.warnings.join("\n"), /Couldn't seat guests A, B — their party of 6 is bigger than any table\./);
});

test("a full wedding still says there's no remaining capacity", () => {
  const result = generateSeatingPlan([guest("A"), guest("B")], [], [table("T1", { capacity: 1 })]);
  assert.match(result.warnings.join("\n"), /no table has enough remaining capacity/);
});

test("a locked guest whose table is gone and who can't be seated anywhere is told both", () => {
  const result = generateSeatingPlan(
    [guest("A", { isLocked: true, currentTableId: "Gone", headcount: 9 })],
    [],
    [table("T1")]
  );
  assert.deepEqual(result.unassignedGuestIds, ["A"]);
  assert.match(
    result.warnings.join("\n"),
    /Guest A was locked to a table that's been removed, and couldn't be seated — their party of 9 is bigger than any table\./
  );
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
