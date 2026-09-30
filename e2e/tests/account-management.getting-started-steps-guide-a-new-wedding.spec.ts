/**
 * TS-96 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-NON-FUNCTIONAL) — a brand-new wedding shows a
 * "Getting started" strip (guests → tables → optional rules → generate) so a first-time planner
 * knows where to begin among ten tabs. It's a hint, not a wizard: each step ticks off as the thing
 * it names exists, each step jumps to its tab, and the whole strip is gone once the wedding has
 * its first plan.
 *
 * TS-115: the strip is drawn in the same render as the tab row, so it never pops in afterwards and
 * pushes the tabs down under a click already on its way.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "account-management.getting-started-steps-guide-a-new-wedding.ticks-off-jumps-and-disappears",
    title: "a new wedding's Getting started steps appear without moving the tabs, tick off as guests and tables are added, jump to their tab, and disappear once a plan is generated",
    objective:
      "Confirms the Getting started strip appears on a wedding with no plan without shifting the tab row once it's on screen, that its guest and table steps show as done once those exist, that a step button opens the matching tab, and that the strip is gone after the first plan is generated.",
    expectedOutcome:
      "On a fresh wedding the tab row's position is the same before and after the page's data settles, and both steps are not done; after adding a guest and a table (and revisiting) both read as done; clicking '4. Generate a seating plan' opens the Seating plan tab; after generating a plan and reloading, no Getting started strip is shown.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const detailPage = new WeddingDetailPage(page);

    await test.step("Assert: a fresh wedding shows the strip with nothing done yet, without moving the tabs", async () => {
      await detailPage.goto(managedWedding.id);
      const tabRowWhenFirstShown = await detailPage.tabRowTop();
      await detailPage.waitForDataToSettle();
      expect(await detailPage.tabRowTop()).toBe(tabRowWhenFirstShown);
      await expect(detailPage.gettingStarted()).toBeVisible();
      await expect(detailPage.gettingStartedStep("1. Add your guests")).not.toHaveAccessibleName(/\(done\)/);
      await expect(detailPage.gettingStartedStep("2. Add tables")).not.toHaveAccessibleName(/\(done\)/);
    });

    await test.step("Act + Assert: once a guest and a table exist, those steps read as done", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
      await detailPage.goto(managedWedding.id);
      await expect(detailPage.gettingStartedStep("1. Add your guests")).toHaveAccessibleName(/\(done\)/);
      await expect(detailPage.gettingStartedStep("2. Add tables")).toHaveAccessibleName(/\(done\)/);
    });

    await test.step("Act + Assert: a step jumps to its tab", async () => {
      await detailPage.gettingStartedStep("4. Generate a seating plan").click();
      await expect(detailPage.tabHeading("Seating plan")).toBeVisible();
    });

    await test.step("Act + Assert: after the first plan, the strip is gone", async () => {
      await weddingData.generatePlanVersion(managedWedding.id);
      await detailPage.goto(managedWedding.id);
      await expect(detailPage.heading()).toBeVisible();
      await expect(detailPage.gettingStarted()).toHaveCount(0);
    });
  },
);
