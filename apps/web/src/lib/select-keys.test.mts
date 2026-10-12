// TS-212: unit tests for which keys open a list's pop-up (a pick from it then saves at once).
// Run with `pnpm --filter @seatwise/web test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectKeyOpensPopup } from "./select-keys";

test("Space, F4 and Alt+Up/Down open the pop-up everywhere", () => {
  for (const isMac of [false, true]) {
    assert.equal(selectKeyOpensPopup(" ", false, isMac), true);
    assert.equal(selectKeyOpensPopup("F4", false, isMac), true);
    assert.equal(selectKeyOpensPopup("ArrowDown", true, isMac), true);
    assert.equal(selectKeyOpensPopup("ArrowUp", true, isMac), true);
  }
});

test("plain arrows open it on a Mac, but change the value in place elsewhere", () => {
  assert.equal(selectKeyOpensPopup("ArrowDown", false, true), true);
  assert.equal(selectKeyOpensPopup("ArrowDown", false, false), false);
  assert.equal(selectKeyOpensPopup("ArrowUp", false, false), false);
});

test("letters, Home/End and Enter never count as opening it", () => {
  for (const key of ["a", "Home", "End", "PageDown", "Enter", "Tab"]) {
    assert.equal(selectKeyOpensPopup(key, false, true), false);
    assert.equal(selectKeyOpensPopup(key, false, false), false);
  }
});
