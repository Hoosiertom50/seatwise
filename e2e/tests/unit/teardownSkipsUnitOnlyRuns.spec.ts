/**
 * TS-215 — the run-end sweep (e2e/support/globalTeardown.ts) deletes every test account. Playwright
 * runs it for any run, so a quick run of only the database-free projects (`unit`, `framework-unit`)
 * used to delete the accounts a browser run in another terminal was still using. It now skips such a
 * run. Pure functions, no database, app or browser (the `unit` project).
 */

import { test, expect } from "@playwright/test";
import { onlyDatabaseFreeProjects, selectedProjects } from "../../support/globalTeardown.js";

const run = (...args: string[]) => ["node", "playwright", "test", ...args];

test("the projects named on the command line are read in both spellings", () => {
  expect(selectedProjects(run("--project=unit", "--project", "framework-unit"))).toEqual(["unit", "framework-unit"]);
  expect(selectedProjects(run("--grep", "x"))).toBeNull();
});

test("a run of only database-free projects skips the sweep", () => {
  expect(onlyDatabaseFreeProjects(run("--project=unit"))).toBe(true);
  expect(onlyDatabaseFreeProjects(run("--project=framework-unit", "--project=unit"))).toBe(true);
});

test("any browser project, or no project named at all, still sweeps", () => {
  expect(onlyDatabaseFreeProjects(run("--project=chromium", "--project=unit"))).toBe(false);
  expect(onlyDatabaseFreeProjects(run("--project", "webkit"))).toBe(false);
  expect(onlyDatabaseFreeProjects(run())).toBe(false);
});
