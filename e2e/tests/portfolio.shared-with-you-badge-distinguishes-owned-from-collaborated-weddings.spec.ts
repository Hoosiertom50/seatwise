/**
 * TS-49 (REQ-PLANNER-PORTFOLIO) — no manual test case exists for this requirement (see the sibling
 * `portfolio.search-filter-and-urgency-sort-reflect-real-plan-and-guest-state.spec.ts` for the full
 * scoping rationale); authored directly from the requirement description.
 *
 * A planner's portfolio isn't only the weddings they personally own -- confirmed directly in
 * apps/web/src/app/dashboard/page.tsx and packages/db/src/queries/weddings.ts's
 * `listWeddingsWithSummaryForUser`: the dashboard lists every wedding a user either owns OR
 * collaborates on (a plain `ownerId = $1 OR id IN (... wedding_collaborators ...)` predicate), and
 * the ONLY thing that tells the two apart in the UI is a `"Shared with you"` pill rendered
 * client-side (`w.ownerId !== userId`) -- the API's own list response carries no `role`/
 * `accessLevel` field per row at all. This test confirms that pill (and its absence) is correct
 * from a second, independently-authenticated planner's own real dashboard, and that each planner's
 * own portfolio lists exactly the weddings they're supposed to -- not the other's unrelated wedding.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { uniqueTitle } from "../data/ids.js";

defineQualityTest(
  {
    id: "portfolio.shared-with-you-badge-distinguishes-owned-from-collaborated-weddings.each-planners-own-dashboard-is-correct",
    title: "a collaborated-on wedding shows 'Shared with you' on the invited planner's own dashboard (and never on the owner's), while each planner's portfolio lists only the weddings they own or collaborate on",
    objective:
      "Confirms a second planner added as a collaborator sees the shared wedding on their own dashboard with a 'Shared with you' badge, does not see the owner's other, unrelated wedding, and that the owner's own dashboard shows both of their weddings with no 'Shared with you' badge on either.",
    expectedOutcome:
      "The collaborator's dashboard lists exactly the one shared wedding, badged 'Shared with you'. The owner's dashboard lists both of their own weddings, neither badged 'Shared with you'.",
    requirementIds: ["REQ-PLANNER-PORTFOLIO"],
    tags: ["@mutating", "@feature:portfolio", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ weddingData, page, browser }, testInfo) => {
    const ownedOnlyName = uniqueTitle(testInfo.workerIndex, "Owner-Only Wedding");
    const sharedName = uniqueTitle(testInfo.workerIndex, "Shared Wedding");
    let sharedWeddingId = "";

    await test.step("Arrange: the planner owns two weddings", async () => {
      await weddingData.createWedding(ownedOnlyName);
      const shared = await weddingData.createWedding(sharedName);
      sharedWeddingId = shared.id;
    });

    const collabSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "collab");
    try {
      await test.step("Arrange: a second planner is added as a collaborator on only the shared wedding", async () => {
        await weddingData.addCollaborator(sharedWeddingId, collabSession.email, "EDIT");
      });

      await test.step("Assert: the collaborator's own dashboard lists only the shared wedding, badged 'Shared with you'", async () => {
        const collabPage = await collabSession.context.newPage();
        const collabDashboard = new DashboardPage(collabPage);
        await collabDashboard.goto();

        const sharedRowText = await collabDashboard.weddingLink(sharedName).textContent();
        expect(sharedRowText).toContain("Shared with you");

        await expect(collabDashboard.weddingLink(ownedOnlyName)).not.toBeVisible();
        await expect(collabDashboard.weddingLinks()).toHaveCount(1);
        await collabPage.close();
      });
    } finally {
      await collabSession.context.close();
    }

    await test.step("Assert: the owner's own dashboard lists both weddings, neither badged 'Shared with you'", async () => {
      const dashboardPage = new DashboardPage(page);
      await dashboardPage.goto();

      const ownedRowText = await dashboardPage.weddingLink(ownedOnlyName).textContent();
      const sharedRowText = await dashboardPage.weddingLink(sharedName).textContent();
      expect(ownedRowText).not.toContain("Shared with you");
      expect(sharedRowText).not.toContain("Shared with you");
    });
  },
);
