// TS-208: unit tests for what the Seating plan tab's Undo puts back. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mustSitGroup, undoPlanFor, undoWouldSplitGroup, type UndoAssignment } from "./plan-undo";

// TS-221: the plan without its seatsBefore snapshot (checked in its own tests below).
const plan = (guestId: string, tableId: string, before: UndoAssignment[], after: UndoAssignment[]) => {
  const p = undoPlanFor(guestId, tableId, before, after);
  if (!p) return p;
  const rest: Partial<typeof p> = { ...p };
  delete rest.seatsBefore;
  return rest;
};

test("a plain move undoes back to the guest's old table", () => {
  assert.deepEqual(plan("a", "T2", [{ guestId: "a", tableId: "T1" }], [{ guestId: "a", tableId: "T2" }]), {
    guestId: "a",
    toTableId: "T2",
    undoTableId: "T1",
    undoOnlyGuestIds: null,
  });
});

test("seating A next to must-sit partner B (already there) undoes only A -- B keeps their seat", () => {
  const before = [{ guestId: "b", tableId: "T2" }];
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  assert.deepEqual(plan("a", "T2", before, after), {
    guestId: "a",
    toTableId: "T2",
    undoTableId: null,
    undoOnlyGuestIds: ["a"],
  });
});

test("seating an unseated pair together undoes both", () => {
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  assert.deepEqual(plan("a", "T2", [], after)?.undoOnlyGuestIds, ["a", "b"]);
});

test("seating A pulls partner B over from T1: undo takes the group to T1 (B keeps a seat)", () => {
  const before = [{ guestId: "b", tableId: "T1" }];
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  assert.deepEqual(plan("a", "T2", before, after), {
    guestId: "a",
    toTableId: "T2",
    undoTableId: "T1",
    undoOnlyGuestIds: null,
  });
});

test("dragging A onto their own table while partner B moves there is recorded (it used to be lost)", () => {
  const before = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T1" },
  ];
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  assert.deepEqual(plan("a", "T2", before, after), {
    guestId: "b",
    toTableId: "T2",
    undoTableId: "T1",
    undoOnlyGuestIds: null,
  });
});

test("nothing changed: nothing to undo", () => {
  const seats = [{ guestId: "a", tableId: "T2" }];
  assert.equal(undoPlanFor("a", "T2", seats, seats), null);
});

// TS-221: undo of a move when the must-sit group wasn't together before it.
const rules = [
  { guestAId: "a", guestBId: "b", type: "MUST_SIT_TOGETHER" },
  { guestAId: "b", guestBId: "c", type: "MUST_SIT_TOGETHER" },
  { guestAId: "a", guestBId: "d", type: "AVOID" },
];

test("mustSitGroup follows chains of must-sit rules only", () => {
  assert.deepEqual(mustSitGroup("a", rules).sort(), ["a", "b", "c"]);
  assert.deepEqual(mustSitGroup("d", rules), ["d"]);
});

test("mustSitGroup leaves out guests marked not attending (as the server does)", () => {
  assert.deepEqual(mustSitGroup("a", rules, new Set(["b"])), ["a"]);
});

test("the plan keeps where everyone sat before the move", () => {
  const before = [
    { guestId: "a", tableId: "T1" },
    { guestId: "b", tableId: "T3" },
  ];
  assert.deepEqual(undoPlanFor("a", "T2", before, [{ guestId: "a", tableId: "T2" }, { guestId: "b", tableId: "T2" }])?.seatsBefore, {
    a: "T1",
    b: "T3",
  });
});

test("a split group (A at T1, partner B at T3) moved to T2 can't be undone -- B was never at T1", () => {
  const before = [
    { guestId: "a", tableId: "T1" },
    { guestId: "b", tableId: "T3" },
  ];
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  const p = undoPlanFor("a", "T2", before, after)!;
  assert.equal(undoWouldSplitGroup(p, ["a", "b"]), true);
});

test("A moved onto partner B's table (B stays put) can't be undone -- undo would take B to A's old table", () => {
  const before = [
    { guestId: "a", tableId: "T1" },
    { guestId: "b", tableId: "T2" },
  ];
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  const p = undoPlanFor("a", "T2", before, after)!;
  assert.equal(p.undoTableId, "T1");
  assert.equal(undoWouldSplitGroup(p, ["a", "b"]), true);
});

test("seating unseated A pulls partner B over from T1: undo would seat A at T1, so it's refused", () => {
  const p = undoPlanFor("a", "T2", [{ guestId: "b", tableId: "T1" }], [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ])!;
  assert.equal(undoWouldSplitGroup(p, ["a", "b"]), true);
});

test("a group that was together moves back together", () => {
  const before = [
    { guestId: "a", tableId: "T1" },
    { guestId: "b", tableId: "T1" },
  ];
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  const p = undoPlanFor("a", "T2", before, after)!;
  assert.equal(undoWouldSplitGroup(p, ["a", "b"]), false);
});

test("a guest with no group always undoes", () => {
  const p = undoPlanFor("a", "T2", [{ guestId: "a", tableId: "T1" }], [{ guestId: "a", tableId: "T2" }])!;
  assert.equal(undoWouldSplitGroup(p, ["a"]), false);
});

test("taking away only the seats a move gave is never refused", () => {
  const p = undoPlanFor("a", "T2", [{ guestId: "b", tableId: "T2" }], [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ])!;
  assert.equal(p.undoTableId, null);
  assert.equal(undoWouldSplitGroup(p, ["a", "b"]), false);
});
