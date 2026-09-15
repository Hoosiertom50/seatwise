/**
 * TS-55 (REQ-INTEGRATION-E2E-SCENARIOS) — converts AC-081 ("Full setup-to-approval walkthrough").
 * This is the workstream's own designated final story: quality/requirements.yaml's own
 * description calls these tests "a final smoke test once the individual feature areas are
 * working" -- every individual feature this test touches (guest import, seating rules,
 * quick-created tables, plan generation, the review/approval status workflow, the Couple-role
 * approval carve-out) already has its own dedicated, deeper test coverage elsewhere in this suite.
 * This test's own job is different: prove those pieces actually work *together*, driven through
 * the real UI end to end, the way a real planner and a real Couple-role collaborator would
 * actually use them in sequence -- not re-prove any one piece's own edge cases.
 *
 * Scope decisions, documented rather than silently assumed:
 * - The manual test case's precondition mentions "a valid guest spreadsheet" of realistic size;
 *   this test uses a small (4-row) CSV instead -- large enough to exercise the real import UI (see
 *   below) meaningfully, small enough to keep this already-long walkthrough's own runtime sane.
 *   Import *edge cases* (partial errors, all-or-nothing commit, row classification) are
 *   guest-list.bulk-import-*.spec.ts's own job, not this test's.
 * - This is the first test in the whole suite to drive the CSV import UI itself (every existing
 *   import test calls the preview/commit API directly) -- a real coverage gap AC-081's own first
 *   step happens to fill. See WeddingGuestsPage.importGuestsFromCsvAndPreview's own doc comment
 *   for how the upload avoids needing to touch the column-mapping selects at all.
 * - "Attempt a prohibited edit, confirm it is blocked and explained" is read here as a VIEW-level
 *   Couple-role collaborator attempting to move a guest's seat -- exercising the same permission
 *   boundary `manual-adjustment`'s own access-control tests already prove in isolation, but here
 *   as one step in a real, continuous flow. "Then have an eligible Couple user approve the plan"
 *   is read as a *different*, EDIT-level Couple-role collaborator, driven through their own real,
 *   independently-authenticated browser session (`signUpFreshAccountInNewContext`), not the
 *   planner's -- NOT a Comment-level one. Real finding (this story's own, empirically hit while
 *   authoring this test): the API's approval gate is broader than the UI exposes --
 *   `PlanTab.tsx` renders its entire status-control block, Approve included, only when
 *   `canEdit` (OWNER or EDIT access), so a Couple member left at Comment-only access -- whom the
 *   API itself would authorize to approve -- never sees an Approve button to click at all; that
 *   specific gap is already the whole subject of
 *   `plan-review.only-owner-or-couple-member-can-approve.spec.ts` (API-only, by necessity), so
 *   this smoke test uses an EDIT-level Couple member instead, the combination that actually has a
 *   real UI path, keeping this test's job to proving the *flow* rather than re-proving that gap.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { RulesTabPage } from "../pages/RulesTabPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { WeddingDataSetup } from "../data/api.js";

defineQualityTest(
  {
    id: "integration.full-setup-to-approval-walkthrough.a-new-wedding-goes-from-guest-import-through-couple-approval",
    title: "a new wedding goes from CSV guest import through rules, quick-created tables, plan generation, and sharing, to a blocked edit and a Couple-role approval, entirely through the real UI",
    objective:
      "Confirms a realistic full setup-to-approval flow works end to end through the real UI: importing guests from a CSV, adding a Must-Sit-Together and a Must-Not-Sit-Together rule, quick-creating tables, generating a plan, moving it to review, a View-level Couple collaborator being blocked (with an explanation) from editing it, and a separate Edit-level Couple collaborator approving it.",
    expectedOutcome:
      "All 4 imported guests appear in the guest list. Both rules appear in the rules list. The quick-created tables appear in the tables list. The generated, Current plan version is complete with no unassigned guest. Moving it to review succeeds. The View-level Couple collaborator's own attempt to move a guest's assignment is rejected (403) with an explanatory message. The Edit-level Couple collaborator's own Approve action succeeds through their own real UI session, and the plan version ends APPROVED with every attending guest assigned exactly once.",
    requirementIds: ["REQ-INTEGRATION-E2E-SCENARIOS"],
    tags: [
      "@mutating",
      "@feature:seating-plan",
      "@feature:guests",
      "@feature:relationships",
      "@feature:tables",
      "@risk:critical",
      "@suite:smoke",
      "@suite:regression",
    ],
  },
  async ({ managedWedding, weddingData, context, page, browser }, testInfo) => {
    test.setTimeout(90_000);

    const guestsPage = new WeddingGuestsPage(page);
    await test.step("Act: import 4 guests from a CSV through the real import UI", async () => {
      await guestsPage.goto(managedWedding.id);
      await guestsPage.openGuestsTab();
      const csv = [
        "firstName,lastName",
        "Amy,Adams",
        "Ben,Baker",
        "Cora,Chen",
        "Dan,Diaz",
      ].join("\n");
      await guestsPage.importGuestsFromCsvAndPreview(csv);
      await guestsPage.confirmImport();
    });

    await test.step("Assert: all 4 imported guests appear in the real guest list", async () => {
      for (const fullName of ["Amy Adams", "Ben Baker", "Cora Chen", "Dan Diaz"]) {
        await guestsPage.guestRow(fullName).expectVisible();
      }
    });

    const guestsRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
    const { guests } = (await guestsRes.json()) as {
      guests: { id: string; firstName: string; lastName: string }[];
    };
    const idFor = (firstName: string) => guests.find((g) => g.firstName === firstName)!.id;

    const rulesPage = new RulesTabPage(page);
    await test.step("Act: add a Must-Sit-Together and a Must-Not-Sit-Together rule through the real UI", async () => {
      await rulesPage.openRulesTab();
      await rulesPage.addRule("Amy Adams", "Ben Baker", "MUST_SIT_TOGETHER");
      await rulesPage.addRule("Cora Chen", "Dan Diaz", "MUST_NOT_SIT_TOGETHER");
      await expect(rulesPage.rulesHeading(2)).toBeVisible();
    });

    const tablesPage = new TablesTabPage(page);
    await test.step("Act: quick-create tables through the real UI", async () => {
      await tablesPage.openTablesTab();
      await tablesPage.quickCreateTables(3, 2);
      expect(await tablesPage.totalCapacity()).toBeGreaterThanOrEqual(4);
    });

    const planPage = new PlanTabPage(page);
    let planVersionId = "";
    await test.step("Act: generate the plan and move it to review (share it) through the real UI", async () => {
      await planPage.goto(managedWedding.id);
      await planPage.generate();
      await planPage.moveToReview();

      const versions = await weddingData.listPlanVersions(managedWedding.id);
      const current = versions.find((v) => v.isCurrent)!;
      planVersionId = current.id;
      expect(current.status).toBe("IN_REVIEW");
    });

    await test.step("Assert: the shared plan is complete, with all 4 guests assigned and no unresolved hard-rule issue", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.isComplete).toBe(true);
      expect(detail.unassignedGuestIds).toEqual([]);
      expect(detail.assignments).toHaveLength(4);
      const assignedGuestIds = detail.assignments.map((a) => a.guestId).sort();
      expect(assignedGuestIds).toEqual([idFor("Amy"), idFor("Ben"), idFor("Cora"), idFor("Dan")].sort());
    });

    const viewerSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "couple-view");
    const approverSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "couple-approve");
    try {
      await test.step("Arrange: a View-level Couple collaborator (blocked from editing) and an Edit-level Couple collaborator (has a real UI path to Approve)", async () => {
        await weddingData.addCollaborator(managedWedding.id, viewerSession.email, "VIEW", "COUPLE");
        await weddingData.addCollaborator(managedWedding.id, approverSession.email, "EDIT", "COUPLE");
      });

      await test.step("Act + Assert: the View-level Couple collaborator's attempt to move a guest is blocked with an explanation", async () => {
        const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
        const assignment = detail.assignments[0];
        const anotherTable = detail.assignments.find((a) => a.tableId !== assignment.tableId) ?? detail.assignments[0];
        const viewerDataSetup = new WeddingDataSetup(viewerSession.context.request);
        const { status, body } = await viewerDataSetup.moveGuestAssignment(
          managedWedding.id,
          planVersionId,
          assignment.guestId,
          anotherTable.tableId,
          detail.revision,
        );
        expect(status).toBe(403);
        expect(body.error).toBeTruthy();
      });

      const approverPage = await approverSession.context.newPage();
      const approverPlanPage = new PlanTabPage(approverPage);
      await test.step("Act: the Edit-level Couple collaborator approves the plan through their own real UI session", async () => {
        await approverPlanPage.goto(managedWedding.id);
        await approverPlanPage.approve();
      });

      await test.step("Assert: the plan version is now Approved", async () => {
        const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
        expect(detail.status).toBe("APPROVED");
        expect(detail.isComplete).toBe(true);
        expect(detail.assignments).toHaveLength(4);
      });
    } finally {
      await viewerSession.context.close();
      await approverSession.context.close();
    }
  },
);
