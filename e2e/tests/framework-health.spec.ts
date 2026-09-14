// Stage 01 acceptance criterion: "Playwright can list and run the framework health test." This
// test deliberately does NOT depend on the Seatwise app (no dev server, no baseURL navigation) --
// it only proves the framework itself (browser launch, page evaluation, assertions) is wired up
// correctly. Tests that exercise the actual application arrive starting in Stage 03/04.
import { test, expect } from "@playwright/test";

test("a real browser launches and can evaluate page content", async ({ page }) => {
  await page.setContent("<html><body><h1>Playwright framework health check</h1></body></html>");
  // pw-lint-exception: raw-selector-in-test -- framework self-test against static inline HTML, never the Seatwise app; spec Section 7.2 explicitly excepts framework self-tests and there is no page object to move this into
  await expect(page.locator("h1")).toHaveText("Playwright framework health check");
});

test("the test runner's own arithmetic is sane", () => {
  expect(1 + 1).toBe(2);
});
