// TS-208: unit tests for what the Seating plan tab's Undo puts back. Run with
// `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { undoPlanFor } from "./plan-undo";

test("a plain move undoes back to the guest's old table", () => {
  assert.deepEqual(undoPlanFor("a", "T2", [{ guestId: "a", tableId: "T1" }], [{ guestId: "a", tableId: "T2" }]), {
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
  assert.deepEqual(undoPlanFor("a", "T2", before, after), {
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
  assert.deepEqual(undoPlanFor("a", "T2", [], after)?.undoOnlyGuestIds, ["a", "b"]);
});

test("seating A pulls partner B over from T1: undo takes the group to T1 (B keeps a seat)", () => {
  const before = [{ guestId: "b", tableId: "T1" }];
  const after = [
    { guestId: "a", tableId: "T2" },
    { guestId: "b", tableId: "T2" },
  ];
  assert.deepEqual(undoPlanFor("a", "T2", before, after), {
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
  assert.deepEqual(undoPlanFor("a", "T2", before, after), {
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
