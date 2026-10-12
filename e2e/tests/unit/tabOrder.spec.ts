/**
 * TS-193 — unit tests for e2e/support/tabOrder.ts's reading-order rules (tabOrderProblems). Pure
 * function, no browser: like ids.spec.ts, nothing here asks for the `page` fixture.
 */

import { test, expect } from "@playwright/test";
import {
  tabOrderProblems,
  tabWalkProblems,
  endAfterFocusFell,
  endWhenTabStaysPut,
  walkWorthRetrying,
  type TabStop,
  type TabWalk,
} from "../../support/tabOrder.js";

let n = 0;
function stop(description: string, left: number, top: number, extra: Partial<TabStop> = {}): TabStop {
  return { index: n++, description, left, top, width: 100, height: 30, pinned: false, ...extra };
}

test.beforeEach(() => {
  n = 0;
});

test.describe("tabOrderProblems", () => {
  test("left to right along a line, then down, is fine", () => {
    const stops = [stop("first name", 0, 0), stop("last name", 200, 0), stop("email", 0, 60), stop("phone", 200, 64), stop("save", 0, 120)];
    expect(tabOrderProblems(stops)).toEqual([]);
  });

  test("going back up the page is reported", () => {
    // A two-column form whose DOM runs down the left column first.
    const stops = [stop("name", 0, 0), stop("email", 0, 60), stop("venue", 200, 0)];
    const problems = tabOrderProblems(stops);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("goes back up the page");
    expect(problems[0]).toContain("email");
  });

  test("going back to the left on the same line is reported", () => {
    const problems = tabOrderProblems([stop("save", 300, 0), stop("cancel", 0, 4)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("back to the left on the same line");
  });

  test("controls of different heights on one line count as the same line", () => {
    // A tall textarea, then a button beside it whose top is a little higher.
    const stops = [stop("notes", 0, 20, { height: 80 }), stop("send", 300, 10, { height: 30 })];
    expect(tabOrderProblems(stops)).toEqual([]);
  });

  test("pinned controls are allowed first, but not after the page content", () => {
    const header = [stop("menu", 0, 500, { pinned: true }), stop("account", 900, 500, { pinned: true })];
    expect(tabOrderProblems([...header, stop("search", 0, 100), stop("add", 0, 200)])).toEqual([]);
    const late = tabOrderProblems([stop("search", 0, 100), stop("bar", 0, 900, { pinned: true })]);
    expect(late).toHaveLength(1);
    expect(late[0]).toContain("pinned");
  });

  test("invisible controls are skipped, and the allow-list excuses a documented step", () => {
    const stops = [stop("name", 0, 0), stop("skip link", 0, 0, { width: 0, height: 0 }), stop("email", 0, 60), stop("venue", 200, 0)];
    expect(tabOrderProblems(stops)).toHaveLength(1);
    expect(tabOrderProblems(stops, { allow: [{ from: /email/, to: /venue/, reason: "unit test" }] })).toEqual([]);
  });
});

// TS-200: whether a walk can be trusted -- it ended cleanly and stopped on exactly the visible controls.
test.describe("tabWalkProblems", () => {
  const walk = (extra: Partial<TabWalk> = {}): TabWalk => ({
    stops: [stop("name", 0, 0), stop("save", 0, 60)],
    end: "left-page",
    maxStops: 250,
    focusableCount: 2,
    unreached: [],
    uncounted: [],
    ...extra,
  });

  test("a walk that left the page, came round or left its region, and reached every control, is fine", () => {
    for (const end of ["left-page", "came-round", "left-region"] as const) {
      expect(tabWalkProblems(walk({ end }))).toEqual([]);
    }
  });

  test("giving up at the stop limit, losing focus or looping is reported", () => {
    expect(tabWalkProblems(walk({ end: "max-stops" }))[0]).toContain("gave up after 250 stops");
    expect(tabWalkProblems(walk({ end: "lost-focus" }))[0]).toContain("focus fell to the page itself");
    expect(tabWalkProblems(walk({ end: "trapped" }))[0]).toContain("came back to a control in the middle");
    expect(tabWalkProblems(walk({ end: "nothing-focusable", stops: [], focusableCount: 0 }))[0]).toContain("no control to start");
  });

  test("a control Tab skips, or a stop that isn't a control, is reported unless allow-listed", () => {
    const skipped = walk({ focusableCount: 3, unreached: ['button "Delete"'] });
    expect(tabWalkProblems(skipped)).toEqual(['Tab never reached button "Delete"']);
    expect(tabWalkProblems(skipped, [{ matches: /Delete/, reason: "unit test" }])).toEqual([]);
    const extra = walk({ stops: [stop("name", 0, 0), stop("list", 0, 30), stop("save", 0, 60)], uncounted: ['div "list"'] });
    expect(tabWalkProblems(extra)).toEqual(['Tab stopped on div "list", which isn\'t a control']);
    expect(tabWalkProblems(extra, [{ matches: /list/, reason: "unit test" }])).toEqual([]);
  });

  test("a count that doesn't match the stops is reported", () => {
    expect(tabWalkProblems(walk({ focusableCount: 3 }))[0]).toContain("2 visible stops, but there are 3 visible controls");
  });
});

// TS-215: a trap must never read as a clean end, and a trap is never walked again until it passes.
test.describe("walk endings and retries", () => {
  const walk = (extra: Partial<TabWalk> = {}): TabWalk => ({
    stops: [stop("name", 0, 0), stop("save", 0, 60)],
    end: "left-page",
    maxStops: 250,
    focusableCount: 2,
    unreached: [],
    uncounted: [],
    ...extra,
  });

  test("after focus falls to the page: nowhere or the first control is leaving; another seen control is a trap", () => {
    const seen = new Set(["1", "2", "3"]);
    expect(endAfterFocusFell(null, seen, "1")).toBe("left-page");
    expect(endAfterFocusFell("1", seen, "1")).toBe("left-page");
    expect(endAfterFocusFell("2", seen, "1")).toBe("trapped");
    expect(endAfterFocusFell("9", seen, "1")).toBe("lost-focus");
  });

  test("Tab staying on one control is leaving the page only when the page didn't hold it there", () => {
    expect(endWhenTabStaysPut(0)).toBe("left-page");
    expect(endWhenTabStaysPut(1)).toBe("stuck");
    expect(tabWalkProblems(walk({ end: "stuck" }))[0]).toContain("Tab stayed on save (stop 2)");
    expect(tabWalkProblems(walk({ end: "stuck" }))[0]).toContain("keyboard trap");
  });

  test("only a count that can still be settling is walked again -- never a trap or lost focus", () => {
    expect(walkWorthRetrying(walk(), [])).toBe(false);
    expect(walkWorthRetrying(walk({ end: "left-page" }), ["Tab never reached x"])).toBe(true);
    expect(walkWorthRetrying(walk({ end: "max-stops" }), ["gave up"])).toBe(true);
    for (const end of ["trapped", "stuck", "lost-focus"] as const) {
      expect(walkWorthRetrying(walk({ end }), ["a problem"])).toBe(false);
    }
  });
});
