/**
 * TS-37 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — converts AC-004 from
 * quality/acceptance-test-plan/Seatwise-Test-Cases-Final.xlsx ("Create an account with multiple
 * weddings"). Account creation itself is already exercised end to end by
 * auth.signup-login-logout.spec.ts, so this test's own Arrange uses the framework's standard
 * `account` fixture (a real signup through the API, Stage 03) and focuses its Act/Assert on the
 * behavior AC-004 actually protects: a planner creating more than one wedding, each showing up
 * and opening independently rather than sharing or overwriting the other's data.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueTitle } from "../data/ids.js";

defineQualityTest(
  {
    id: "account-management.multiple-weddings-are-independent.each-opens-to-its-own-details",
    title: "a planner account can create multiple weddings that each open independently",
    objective:
      "Confirms a signed-in planner can create more than one wedding under their account, and that both appear on the dashboard and open to their own distinct details rather than colliding.",
    expectedOutcome:
      "Both weddings appear in the planner's dashboard list, and opening each one shows that wedding's own name and venue, not the other's.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:high", "@suite:regression"],
  },
  async ({ account, page, evidence }, testInfo) => {
    void account; // Arrange: the account fixture already signed this planner up.
    const dashboardPage = new DashboardPage(page);
    const weddingDetailPage = new WeddingDetailPage(page);
    const weddingAName = uniqueTitle(testInfo.workerIndex, "Wedding A");
    const weddingBName = uniqueTitle(testInfo.workerIndex, "Wedding B");

    await test.step("Arrange: open the dashboard", async () => {
      await dashboardPage.goto();
    });

    await test.step("Act: create Wedding A and Wedding B", async () => {
      await dashboardPage.createWedding({ name: weddingAName, venueName: "The Grandview Estate" });
      await dashboardPage.createWedding({ name: weddingBName, venueName: "Harbor Pavilion" });
    });

    await test.step("Assert: both weddings appear in the dashboard list", async () => {
      await expect(dashboardPage.weddingLink(weddingAName)).toBeVisible();
      await expect(dashboardPage.weddingLink(weddingBName)).toBeVisible();
    });

    await test.step("Assert: opening Wedding A shows Wedding A's own name and venue", async () => {
      await dashboardPage.openWedding(weddingAName);
      await expect(weddingDetailPage.heading()).toHaveText(weddingAName);
      await expect(weddingDetailPage.textLocator("The Grandview Estate")).toBeVisible();
    });

    await test.step("Assert: opening Wedding B shows Wedding B's own name and venue, independent of Wedding A", async () => {
      await dashboardPage.goto();
      await dashboardPage.openWedding(weddingBName);
      await expect(weddingDetailPage.heading()).toHaveText(weddingBName);
      await expect(weddingDetailPage.textLocator("Harbor Pavilion")).toBeVisible();
      await expect(weddingDetailPage.textLocator(weddingAName)).not.toBeVisible();
    });

    await evidence.checkpoint(
      "both-weddings-independent",
      `Wedding B's detail page shows only "${weddingBName}" and "Harbor Pavilion" -- none of Wedding A's data.`,
    );
  },
);
