// TS-199: unit tests for the floor plans' reading order. Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inReadingOrder } from "./reading-order";

type Box = { id: string; x: number; y: number };
const ids = (boxes: Box[]) => inReadingOrder(boxes, (b) => b).map((b) => b.id);

test("rows top to bottom, each row left to right -- not the order the tables were made", () => {
  const boxes: Box[] = [
    { id: "bottom-left", x: 40, y: 400 },
    { id: "top-right", x: 600, y: 40 },
    { id: "top-left", x: 40, y: 40 },
    { id: "bottom-right", x: 600, y: 400 },
  ];
  assert.deepEqual(ids(boxes), ["top-left", "top-right", "bottom-left", "bottom-right"]);
});

test("a table a few pixels lower than its neighbour still reads as the same row", () => {
  const boxes: Box[] = [
    { id: "right", x: 400, y: 40 },
    { id: "left-slightly-lower", x: 40, y: 52 },
  ];
  assert.deepEqual(ids(boxes), ["left-slightly-lower", "right"]);
});

test("tables on the same spot keep the order they came in", () => {
  const boxes: Box[] = [
    { id: "first", x: 40, y: 40 },
    { id: "second", x: 40, y: 40 },
  ];
  assert.deepEqual(ids(boxes), ["first", "second"]);
});

test("the list it was given is left alone", () => {
  const boxes: Box[] = [
    { id: "b", x: 300, y: 40 },
    { id: "a", x: 40, y: 40 },
  ];
  inReadingOrder(boxes, (b) => b);
  assert.deepEqual(boxes.map((b) => b.id), ["b", "a"]);
});
