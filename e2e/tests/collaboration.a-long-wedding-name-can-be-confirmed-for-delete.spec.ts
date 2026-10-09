/**
 * TS-258 (REQ-COLLABORATION-NOTIFICATIONS) — "Delete this wedding" asks the owner to type the
 * wedding's name. The confirm box was capped at the name limit (200 characters), so a wedding
 * saved with a longer name (older data) could never be confirmed, and never deleted. The box now
 * takes the whole saved name.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueTitle } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { plantOldWeddingName } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "collaboration.a-long-wedding-name-can-be-confirmed-for-delete.typed-in-full",
    title: "a wedding whose saved name is longer than the limit can still be confirmed and deleted",
    objective:
      "Confirms that when a wedding's saved name is 250 characters (longer than today's 200-character limit, as older data can be), the owner can type the whole name into the Delete this wedding confirm box, the Delete wedding button becomes enabled, and confirming deletes the wedding.",
    expectedOutcome:
      "The confirm box holds all 250 characters, Delete wedding is enabled, and after confirming the owner is on the dashboard without the wedding and the wedding's API answers 404.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ weddingData, context, page }, testInfo) => {
    const base = uniqueTitle(testInfo.workerIndex, "Long Name");
    const w = (await weddingData.createWedding(base)).id;
    const longName = `${base} ${"Wedding ".repeat(40)}`.slice(0, 249) + "z";
    expect(longName.length).toBe(250);
    await plantOldWeddingName(w, longName);

    const tab = new CollaboratorsTabPage(page);
    await test.step("The whole saved name fits in the confirm box and enables Delete wedding", async () => {
      await tab.goto(w);
      await expect(tab.deleteWeddingButton()).toBeDisabled();
      await tab.deleteWeddingConfirmInput().fill(longName);
      await expect(tab.deleteWeddingConfirmInput()).toHaveValue(longName);
      await expect(tab.deleteWeddingButton()).toBeEnabled();
    });

    await test.step("Confirming deletes the wedding", async () => {
      await tab.deleteWedding(longName);
      await expect(new DashboardPage(page).weddingLink(longName)).toHaveCount(0);
      expect((await context.request.get(`/api/v1/weddings/${w}`)).status()).toBe(404);
    });
  },
);
