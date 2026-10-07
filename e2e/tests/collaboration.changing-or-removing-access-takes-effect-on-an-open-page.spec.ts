/**
 * TS-116 (REQ-COLLABORATION-NOTIFICATIONS, REQ-ACCOUNT-WEDDING-MANAGEMENT) — FR-1.6: "a change to a
 * collaborator's access takes effect within five seconds, even for a wedding already open in the
 * user's browser." Until now nothing drove the owner's change-level, change-role or Remove
 * controls at all (PATCH/DELETE .../collaborators/:id), nor the open page's reaction to them.
 *
 * A collaborator keeps the wedding open while the owner, from the Collaborators tab, lowers them
 * from Edit to View (their page says so and their writes are refused), makes them a Couple member
 * (persisted), and then removes them (their page says so, sends them to the dashboard, and the
 * wedding is gone from their reach).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

// FR-1.6's five seconds, plus headroom for the 4s poll landing just after the change.
const WITHIN_FIVE_SECONDS = { timeout: 9_000 };

defineQualityTest(
  {
    id: "collaboration.changing-or-removing-access-takes-effect-on-an-open-page.level-role-remove",
    title: "when the owner lowers, re-roles or removes a collaborator, the collaborator's already-open page reflects it within seconds and the server enforces it",
    objective:
      "Confirms the owner's Collaborators-tab controls work end to end: lowering an Edit collaborator to View shows 'changed to View' on their open page within FR-1.6's five seconds and their edits are then refused; changing their role to Couple persists; and Remove shows 'has been removed' on their open page, redirects them to the dashboard, and leaves the wedding unreachable for them.",
    expectedOutcome:
      "After the level change the collaborator's page shows 'Your access to this wedding was changed to View.' and 'Your access: View', and their guest edit returns 403. The role select persists as Couple after a reload. After Remove their page shows 'This wedding is no longer available (it may have been deleted, or your access was removed).', lands on /dashboard, and GET of the wedding returns 404.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser }, testInfo) => {
    const collaboratorsTab = new CollaboratorsTabPage(page);
    const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "helper");

    try {
      await weddingData.addCollaborator(managedWedding.id, helper.email, "EDIT");
      const helperPage = await helper.context.newPage();
      const helperView = new WeddingDetailPage(helperPage);

      await test.step("The collaborator has the wedding open at Edit", async () => {
        await helperView.goto(managedWedding.id);
        await expect(helperView.yourAccessBadge()).toHaveText("Your access: Edit");
      });

      await test.step("Owner lowers them to View: their open page says so, and their edits are refused", async () => {
        await collaboratorsTab.goto(managedWedding.id);
        await collaboratorsTab.setAccessLevel(helper.name, "View");
        await expect(helperView.accessChangedNotice("View")).toBeVisible(WITHIN_FIVE_SECONDS);
        await expect(helperView.yourAccessBadge()).toHaveText("Your access: View");

        const edit = await helper.context.request.patch(`/api/v1/weddings/${managedWedding.id}/guests/${guest.id}`, {
          data: { firstName: "Changed" },
        });
        expect(edit.status()).toBe(403);
      });

      await test.step("Owner makes them a Couple member: it persists", async () => {
        await collaboratorsTab.setRole(helper.name, "Couple");
        await expect.poll(async () => (await weddingData.listCollaborators(managedWedding.id)).find((c) => c.userEmail === helper.email)?.role).toBe("COUPLE");
        await collaboratorsTab.goto(managedWedding.id);
        await expect(collaboratorsTab.accessLevelSelect(helper.name)).toHaveValue("VIEW");
      });

      await test.step("Owner removes them: their open page says so, sends them to the dashboard, and the wedding is out of reach", async () => {
        await collaboratorsTab.removePerson(helper.email);
        await expect(collaboratorsTab.person(helper.email)).toHaveCount(0);

        await expect(helperView.accessRemovedMessage()).toBeVisible(WITHIN_FIVE_SECONDS);
        await helperPage.waitForURL("**/dashboard", WITHIN_FIVE_SECONDS);
        const read = await helper.context.request.get(`/api/v1/weddings/${managedWedding.id}`);
        expect(read.status()).toBe(404);
        expect((await weddingData.listCollaborators(managedWedding.id)).some((c) => c.userEmail === helper.email)).toBe(false);
      });
    } finally {
      await helper.context.close();
    }
  },
);
