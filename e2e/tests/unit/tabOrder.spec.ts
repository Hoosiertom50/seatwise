/**
 * TS-193 — unit tests for e2e/support/tabOrder.ts's reading-order rules (tabOrderProblems). Pure
 * function, no browser: like ids.spec.ts, nothing here asks for the `page` fixture.
 */

import { test, expect } from "@playwright/test";
import { tabOrderProblems, type TabStop } from "../../support/tabOrder.js";

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
