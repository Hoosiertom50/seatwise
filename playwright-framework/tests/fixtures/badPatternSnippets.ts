/**
 * Stage 04 — intentionally bad test-authoring patterns, used ONLY by this framework's own
 * validation tests (playwright-framework/tests/lintRules.spec.ts). Spec Stage 04 task: "Create
 * examples of intentionally bad patterns used only by framework validation tests."
 *
 * These are plain string constants, never real `.spec.ts` files -- so Playwright never collects
 * or runs any of the broken code they contain (a `test.only`, a swallowed error, a test with zero
 * assertions...). They exist purely as literal source text handed to `checkTestSource` in unit
 * tests, exactly the same way `tagValidation.spec.ts`/`validateMetadata.spec.ts` feed synthetic
 * data to their subjects rather than real quality/*.yaml files.
 */

export const RAW_SELECTOR_IN_TEST = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  await page.goto("/weddings/123");
  await page.locator("li").filter({ hasText: "Jane" }).click();
  await expect(page.locator("li")).toBeVisible();
});
`;

/** Same violation as RAW_SELECTOR_IN_TEST, but the fixture parameter is destructure-renamed
 * (\`{ page: p }\`) -- an ordinary pattern in a multi-page test, not an exotic evasion. Added after
 * the Stage 04 audit found this defeated the rule entirely: the checker only matched the literal
 * identifier "page"/"context"/"frame", so any rename silently bypassed it. */
export const RAW_SELECTOR_VIA_RENAMED_PAGE = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page: p }) => {
  await p.goto("/weddings/123");
  await p.locator("li").filter({ hasText: "Jane" }).click();
  await expect(p.locator("li")).toBeVisible();
});
`;

/** Same violation again, but the alias comes from a plain local variable assignment rather than a
 * destructured parameter rename -- \`const thePage = page;\` -- the other ordinary way a receiver
 * ends up under a different name. */
export const RAW_SELECTOR_VIA_LOCAL_ALIAS = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  const thePage = page;
  await thePage.goto("/weddings/123");
  await thePage.locator("li").filter({ hasText: "Jane" }).click();
  await expect(thePage.locator("li")).toBeVisible();
});
`;

export const RAW_SCREENSHOT_IN_TEST = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  await expect(page.getByText("Jane")).toBeVisible();
  await page.screenshot({ path: "evidence.png" });
});
`;

export const FIXED_WAIT_IN_TEST = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  await page.waitForTimeout(5000);
  await expect(page.getByText("Jane")).toBeVisible();
});
`;

export const TEST_ONLY = `
import { test, expect } from "@playwright/test";

test.only("a planner can see the guest list", async ({ page }) => {
  await expect(page.getByText("Jane")).toBeVisible();
});
`;

export const UNREASONED_SKIP = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  test.skip(true);
  await expect(page.getByText("Jane")).toBeVisible();
});
`;

export const REASONED_SKIP_OK = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  test.skip(true, "Blocked on TS-99 -- guest list pagination isn't implemented yet.");
  await expect(page.getByText("Jane")).toBeVisible();
});
`;

export const SWALLOWED_ERROR = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  try {
    await page.goto("/weddings/123");
  } catch (err) {
    console.log("navigation failed, ignoring");
  }
  await expect(page.getByText("Jane")).toBeVisible();
});
`;

export const RETHROWN_ERROR_OK = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page, testInfo }) => {
  try {
    await page.goto("/weddings/123");
  } catch (err) {
    await testInfo.attach("navigation-failure", { body: String(err), contentType: "text/plain" });
    throw err;
  }
  await expect(page.getByText("Jane")).toBeVisible();
});
`;

export const MISSING_ASSERTION = `
import { test } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  await page.goto("/weddings/123");
});
`;

export const EXCEPTION_COMMENT_SUPPRESSES_RULE = `
import { test, expect } from "@playwright/test";

test("a planner can see the guest list", async ({ page }) => {
  // pw-lint-exception: fixed-wait -- app has a known 2s animation with no observable completion signal yet (TS-101 tracks adding one)
  await page.waitForTimeout(2000);
  await expect(page.getByText("Jane")).toBeVisible();
});
`;

/** A clean test with no violations at all, used as a negative control (the checker must not flag
 * anything in well-formed source). */
export const CLEAN_TEST = `
import { defineQualityTest, expect } from "../fixtures/index.js";

defineQualityTest(
  {
    id: "example.clean-reference",
    title: "a planner can see the guest list",
    objective: "Confirms the guest list renders for a signed-in planner.",
    expectedOutcome: "The guest list shows every guest created in setup.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@readonly", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ weddingGuestsPage, managedWedding }) => {
    await weddingGuestsPage.goto(managedWedding.id);
    await weddingGuestsPage.openGuestsTab();
    const row = weddingGuestsPage.guestRow("Playwright Tester-abc");
    await row.expectVisible();
    await expect.poll(() => row.rsvpStatus()).toBe("PENDING");
  },
);
`;
