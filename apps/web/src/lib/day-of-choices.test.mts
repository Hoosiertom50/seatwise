// TS-208: unit tests for the tables Day-of mode offers, and what it says after seating someone.
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tableChoicesFor, seatResultMessage, mustSitGroup, nameList, type ChoiceContext, type ChoiceTable } from "./day-of-choices";

const guest = (id: string, extra: Partial<{ headcount: number; requiresAccessibleTable: boolean; dayOfAttendance: string }> = {}) => ({
  id,
  headcount: 1,
  requiresAccessibleTable: false,
  dayOfAttendance: "ATTENDING",
  ...extra,
});
const table = (id: string, capacity: number, extra: Partial<ChoiceTable> = {}): ChoiceTable => ({
  id,
  label: id,
  capacity,
  isAccessible: false,
  isRestricted: false,
  requiredGuestIds: [],
  ...extra,
});
const labels = (choices: { table: ChoiceTable; free: number }[]) => choices.map((c) => `${c.table.label} (${c.free} free)`);

test("Move leaves out a table where someone has a must-not-sit-together rule with the guest", () => {
  const ctx: ChoiceContext = {
    guests: [guest("a"), guest("enemy"), guest("x")],
    tables: [table("T1", 4), table("T2", 4), table("T3", 4)],
    assignments: [
      { guestId: "a", tableId: "T1" },
      { guestId: "enemy", tableId: "T2" },
      { guestId: "x", tableId: "T3" },
    ],
    relationships: [{ guestAId: "enemy", guestBId: "a", type: "MUST_NOT_SIT_TOGETHER" }],
  };
  assert.deepEqual(labels(tableChoicesFor("a", ctx)), ["T3 (3 free)"]);
});

test("...including a rule with a must-sit partner who moves along", () => {
  const ctx: ChoiceContext = {
    guests: [guest("a"), guest("b"), guest("enemy")],
    tables: [table("T1", 4), table("T2", 4), table("T3", 4)],
    assignments: [
      { guestId: "a", tableId: "T1" },
      { guestId: "b", tableId: "T1" },
      { guestId: "enemy", tableId: "T2" },
    ],
    relationships: [
      { guestAId: "a", guestBId: "b", type: "MUST_SIT_TOGETHER" },
      { guestAId: "b", guestBId: "enemy", type: "MUST_NOT_SIT_TOGETHER" },
    ],
  };
  assert.deepEqual(labels(tableChoicesFor("a", ctx)), ["T3 (4 free)"]);
});

test("Seat (an unseated guest) leaves out full, inaccessible and Restricted tables and shows free seats", () => {
  const ctx: ChoiceContext = {
    guests: [guest("a", { requiresAccessibleTable: true }), guest("big", { headcount: 2 })],
    tables: [
      table("Full", 2),
      table("Steps", 6),
      table("Ramp", 6, { isAccessible: true }),
      table("Family", 6, { isAccessible: true, isRestricted: true, requiredGuestIds: ["someone-else"] }),
    ],
    assignments: [{ guestId: "big", tableId: "Full" }],
    relationships: [],
  };
  assert.deepEqual(labels(tableChoicesFor("a", ctx)), ["Ramp (6 free)"]);
});

test("Seat counts a must-sit partner already at a table as staying (only the guest needs a seat there)", () => {
  const ctx: ChoiceContext = {
    guests: [guest("a"), guest("b"), guest("c")],
    tables: [table("T1", 2), table("T2", 3)],
    assignments: [
      { guestId: "b", tableId: "T1" },
      { guestId: "c", tableId: "T1" },
    ],
    relationships: [{ guestAId: "a", guestBId: "b", type: "MUST_SIT_TOGETHER" }],
  };
  // T1 has room for A only if B's own seat is counted as staying -- it has 0 free, but B is there.
  // A and B need 2 seats: T1 has 2 - (2 - 1) = 1 room, so no; T2 has 3.
  assert.deepEqual(labels(tableChoicesFor("a", ctx)), ["T2 (3 free)"]);
});

test("a guest on a Restricted table's list is offered only that table", () => {
  const ctx: ChoiceContext = {
    guests: [guest("vip")],
    tables: [table("Open", 8), table("Head", 4, { isRestricted: true, requiredGuestIds: ["vip"] })],
    assignments: [],
    relationships: [],
  };
  assert.deepEqual(labels(tableChoicesFor("vip", ctx)), ["Head (4 free)"]);
});

test("a walk-in is offered every table with a free seat that isn't Restricted", () => {
  const ctx: ChoiceContext = {
    guests: [guest("x", { headcount: 2 })],
    tables: [table("Full", 2), table("Open", 5), table("Head", 4, { isRestricted: true, requiredGuestIds: ["x"] })],
    assignments: [{ guestId: "x", tableId: "Full" }],
    relationships: [],
  };
  assert.deepEqual(labels(tableChoicesFor(null, ctx)), ["Open (5 free)"]);
});

test("a walk-in party is offered only tables with a seat for each of them (TS-202 party size)", () => {
  const ctx: ChoiceContext = {
    guests: [guest("x", { headcount: 3 })],
    tables: [table("Small", 5), table("Big", 8)],
    assignments: [{ guestId: "x", tableId: "Small" }],
    relationships: [],
  };
  assert.deepEqual(labels(tableChoicesFor(null, ctx, 2)), ["Small (2 free)", "Big (8 free)"]);
  assert.deepEqual(labels(tableChoicesFor(null, ctx, 3)), ["Big (8 free)"]);
});

test("must-sit groups count attending guests only", () => {
  const ctx = {
    guests: [guest("a"), guest("b", { dayOfAttendance: "NOT_ATTENDING" }), guest("c")],
    relationships: [
      { guestAId: "a", guestBId: "b", type: "MUST_SIT_TOGETHER" },
      { guestAId: "a", guestBId: "c", type: "MUST_SIT_TOGETHER" },
    ],
  };
  assert.deepEqual(mustSitGroup("a", ctx).sort(), ["a", "c"]);
});

test("Seat announces who was seated, and says Moved when a partner came from another table", () => {
  const after = [
    { guestId: "a", tableId: "T2", guestName: "Ann Lee", tableLabel: "T2" },
    { guestId: "b", tableId: "T2", guestName: "Bo Diaz", tableLabel: "T2" },
  ];
  assert.equal(seatResultMessage("a", "T2", [{ guestId: "b", tableId: "T2" }], after), "Seated Ann Lee at T2.");
  assert.equal(seatResultMessage("a", "T2", [{ guestId: "b", tableId: "T1" }], after), "Moved Ann Lee and Bo Diaz to T2.");
  assert.equal(seatResultMessage("a", "T2", [], after), "Seated Ann Lee and Bo Diaz at T2.");
  assert.equal(seatResultMessage("a", "T2", after, after), null);
});

test("names read as a list", () => {
  assert.equal(nameList(["A"]), "A");
  assert.equal(nameList(["A", "B"]), "A and B");
  assert.equal(nameList(["A", "B", "C"]), "A, B and C");
});
