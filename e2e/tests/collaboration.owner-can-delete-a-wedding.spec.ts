/**
 * TS-161 (REQ-COLLABORATION-NOTIFICATIONS) — the owner can delete a wedding from the app. The
 * server always allowed it (owner only), but no screen offered it. The Collaborators tab now has a
 * "Delete this wedding" section for the owner only: typing the wedding's name enables the button,
 * which asks once more. Deleting returns to the dashboard; collaborators lose access and the
 * wedding's RSVP links stop working.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "collaboration.owner-can-delete-a-wedding.typed-name-confirm-owner-only",
    title: "the owner can delete a wedding after typing its name; collaborators can't, and its links stop working",
    objective:
      "Confirms that an Edit collaborator sees no Delete wedding control and is refused by the API; that the owner's Delete wedding button stays disabled until the exact wedding name is typed; and that confirming returns the owner to the dashboard without the wedding, the collaborator can no longer open it, and the wedding's RSVP link reads NOT_FOUND.",
    expectedOutcome:
      "Collaborator: no Delete wedding button, API DELETE 403. Owner: button disabled for a wrong name, enabled for the right one; after confirming, the dashboard no longer lists the wedding, the collaborator gets 403/404 for it, and the RSVP preview status is NOT_FOUND.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ weddingData, context, browser, page }, testInfo) => {
    test.setTimeout(60_000);
    const name = uniqueTitle(testInfo.workerIndex, "Delete Me");
    const w = (await weddingData.createWedding(name)).id;
    const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
    const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    try {
      await weddingData.addCollaborator(w, editor.email, "EDIT");

      await test.step("A collaborator, even with Edit access, can't delete the wedding", async () => {
        const theirTab = new CollaboratorsTabPage(await editor.context.newPage());
        await theirTab.goto(w);
        await expect(theirTab.deleteWeddingButton()).toHaveCount(0);
        expect((await editor.context.request.delete(`/api/v1/weddings/${w}`)).status()).toBe(403);
      });

      const tab = new CollaboratorsTabPage(page);
      await test.step("The owner's button only works once the wedding's exact name is typed", async () => {
        await tab.goto(w);
        await expect(tab.deleteWeddingButton()).toBeDisabled();
        await tab.deleteWeddingConfirmInput().fill(`${name} typo`);
        await expect(tab.deleteWeddingButton()).toBeDisabled();
        await tab.deleteWeddingConfirmInput().fill(name);
        await expect(tab.deleteWeddingButton()).toBeEnabled();
      });

      await test.step("Deleting returns to the dashboard; access and links are gone", async () => {
        await tab.deleteWedding(name);
        const dashboard = new DashboardPage(page);
        await expect(dashboard.weddingLink(name)).toHaveCount(0);
        expect([403, 404]).toContain((await editor.context.request.get(`/api/v1/weddings/${w}`)).status());
        const preview = (await (await context.request.get(`/api/v1/rsvp/${token}`)).json()) as { rsvp: { status: string } };
        expect(preview.rsvp.status).toBe("NOT_FOUND");
      });
    } finally {
      await editor.context.close();
    }
  },
);
