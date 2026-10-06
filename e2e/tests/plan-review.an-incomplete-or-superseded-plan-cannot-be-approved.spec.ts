/**
 * TS-116 (REQ-PLAN-REVIEW-STATUS) — approval means "this is the seating plan", so it must never be
 * reachable for a plan that leaves someone without a seat, or for a version that's been
 * superseded by a newer one (packages/db/src/queries/plan-versions.ts, setPlanVersionStatus).
 *
 * On screen, an incomplete plan in review shows Approve disabled with "Seat every guest before
 * this can be approved." On the server, approving it anyway is refused (409), and so is any
 * status change on a version that's no longer current.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "plan-review.an-incomplete-or-superseded-plan-cannot-be-approved.ui-and-server",
    title: "a plan with unseated guests can't be approved -- the button is disabled with a reason and the server refuses it -- and a superseded version's status can't be changed",
    objective:
      "Confirms that an in-review plan with an unseated guest shows Approve disabled with 'Seat every guest before this can be approved.', that approving it through the API is refused with 409 and the plan stays In Review, and that once a newer version exists, any status change on the older one is refused with 409.",
    expectedOutcome:
      "Approve is disabled and the reason is shown. POST status APPROVED returns 409 'can't be approved yet', and the version is still IN_REVIEW. After regenerating, POST status on the older version returns 409 'has been superseded' and its status is unchanged.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const planTab = new PlanTabPage(page);
    let incompleteId = "";

    await test.step("Arrange: three guests and only two seats, so the plan leaves one guest unseated", async () => {
      for (let i = 0; i < 3; i++) await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.createTable(managedWedding.id, { label: "Only table", capacity: 2 });
      const plan = await weddingData.generatePlanVersion(managedWedding.id);
      expect(plan.isComplete).toBe(false);
      incompleteId = plan.id;
    });

    await test.step("On screen: in review, Approve is disabled and says why", async () => {
      await planTab.goto(managedWedding.id);
      await planTab.moveToReview();
      await expect(planTab.approveControl()).toBeDisabled();
      await expect(planTab.textLocator("Seat every guest, and sort out anyone flagged Needs Reassignment, before this can be approved.")).toBeVisible();
    });

    await test.step("On the server: approving it anyway is refused, and it stays in review", async () => {
      const res = await weddingData.setPlanVersionStatus(managedWedding.id, incompleteId, "APPROVED");
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("can't be approved yet");
      expect((await weddingData.getPlanVersionDetail(managedWedding.id, incompleteId)).status).toBe("IN_REVIEW");
    });

    await test.step("A superseded version's status can't be changed", async () => {
      await weddingData.generatePlanVersion(managedWedding.id);
      for (const status of ["DRAFT", "APPROVED"] as const) {
        const res = await weddingData.setPlanVersionStatus(managedWedding.id, incompleteId, status);
        expect(res.status, status).toBe(409);
        expect(res.body.error).toContain("has been superseded");
      }
      expect((await weddingData.getPlanVersionDetail(managedWedding.id, incompleteId)).status).toBe("IN_REVIEW");
    });
  },
);
