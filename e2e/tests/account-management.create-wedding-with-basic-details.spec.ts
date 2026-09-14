/**
 * TS-37 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — converts AC-006 ("Enter and save basic wedding
 * details"). The workbook's own steps ("enter the couple's names, wedding date, and venue name;
 * leave the optional note blank and save; reopen the wedding") describe this app's create-wedding
 * form itself (there is no separate "edit wedding details" screen — see
 * updateWeddingSchema/PATCH /api/v1/weddings/:id, which the frontend never calls), so this test's
 * Act is the same dashboard create form AC-004's test also uses, with its own distinct assertion:
 * that leaving the note blank doesn't block saving, and that the entered name/venue/date survive
 * a real reopen rather than just being echoed back from the create response.
 *
 * The rendered date text (`toLocaleDateString()`) is locale-dependent, so this deliberately checks
 * for the absence of the "No date set" placeholder rather than asserting an exact formatted string
 * -- confirming a date was persisted without coupling the test to one locale's date format.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueTitle } from "../data/ids.js";

defineQualityTest(
  {
    id: "account-management.create-wedding-with-basic-details.blank-note-and-reopen",
    title: "a planner can enter and save basic wedding details with the optional note left blank",
    objective:
      "Confirms a planner can create a wedding with a name, date, and venue while leaving the optional note blank, and that reopening the wedding shows the values that were entered.",
    expectedOutcome:
      "The wedding saves without error despite the blank note, and its detail page shows the entered name, venue, and a saved date (not the \"No date set\" placeholder) after reopening.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page, evidence }, testInfo) => {
    void account;
    const dashboardPage = new DashboardPage(page);
    const weddingDetailPage = new WeddingDetailPage(page);
    const weddingName = uniqueTitle(testInfo.workerIndex, "Basic Details Wedding");
    const venueName = "Harbor Pavilion";
    // A date safely in the future, in the yyyy-mm-dd shape the native <input type="date"> expects.
    const eventDate = "2027-06-12";

    await test.step("Arrange: open the dashboard", async () => {
      await dashboardPage.goto();
    });

    await test.step("Act: enter the wedding's name, date, and venue, leave the note blank, and save", async () => {
      await dashboardPage.createWedding({ name: weddingName, date: eventDate, venueName });
    });

    await test.step("Assert: reopening the wedding shows the entered name, venue, and a saved date", async () => {
      await dashboardPage.openWedding(weddingName);
      await expect(weddingDetailPage.heading()).toHaveText(weddingName);
      await expect(weddingDetailPage.textLocator(venueName)).toBeVisible();
      await expect(weddingDetailPage.textLocator("No date set")).not.toBeVisible();
    });

    await evidence.checkpoint(
      "wedding-details-persisted",
      `"${weddingName}" reopens showing "${venueName}" and a saved date, with no note required.`,
    );
  },
);
