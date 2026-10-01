/**
 * TS-118 (REQ-PLAN-REVIEW-STATUS) — the Seating plan tab's version screens, which the 2026-09-30
 * coverage audit found untested through the UI:
 *
 * - "How is this calculated?" opens and closes the score explanation.
 * - A version's nickname can be added, cancelled, renamed, and a stale rename is refused.
 * - Two versions can be compared; comparing a version with itself is refused.
 * - Status moves Draft → In review → back to Draft, and Approved → Reopen for review.
 * - A past version says it's read-only and offers no status buttons; Restore previews first, can
 *   be cancelled with nothing created, and Confirm restore makes a new current version.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "plan-review.plan-version-screens-nickname-compare-status-and-restore.score-nickname-compare-status-past-restore",
    title: "a plan version's score explanation, nickname, comparison, status changes and restore all work from the Seating plan tab",
    objective:
      "Confirms that the score explanation toggles; that a nickname can be cancelled, added and renamed, and a rename based on a stale version is refused; that comparing two versions shows a moved/added/removed/unchanged summary and comparing a version with itself is refused with 'Choose two different plan versions to compare.'; that status can go In review → Draft and Approved → In review; and that a past version shows its read-only notice with no status buttons, its restore preview can be cancelled with no version created, and confirming creates a new current version.",
    expectedOutcome:
      "The toggle reads 'Hide calculation' then 'How is this calculated?'. Cancel leaves no label; Save stores 'Option A', then 'Option B'; a stale save shows the 'someone else's change landed first' message. The comparison summary appears, and the same-version comparison shows the refusal. The API status reads DRAFT after Move back to draft and IN_REVIEW after Reopen for review. On v1: the past-version notice shows, there are no status buttons, Cancel leaves the version count unchanged, and Confirm restore adds a version that is current.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }, testInfo) => {
    const w = managedWedding.id;
    const plan = new PlanTabPage(page);
    for (let i = 0; i < 3; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "One", capacity: 4 });
    await weddingData.createTable(w, { label: "Two", capacity: 4 });
    await weddingData.generatePlanVersion(w);

    const versions = () => weddingData.listPlanVersions(w);
    const current = async () => (await versions()).find((v) => v.isCurrent)!;

    await plan.goto(w);
    await plan.generate();
    expect(await versions()).toHaveLength(2);

    await test.step("The score explanation opens and closes", async () => {
      await expect(plan.scoreExplanationToggle()).toHaveText("How is this calculated?");
      await plan.scoreExplanationToggle().click();
      await expect(plan.scoreExplanationToggle()).toHaveText("Hide calculation");
      await plan.scoreExplanationToggle().click();
      await expect(plan.scoreExplanationToggle()).toHaveText("How is this calculated?");
    });

    await test.step("A nickname can be cancelled, added and renamed; a stale rename is refused", async () => {
      await plan.setNickname("Never saved", false);
      await expect(plan.addNicknameButton()).toHaveText("Add a nickname...");
      expect((await current()).label).toBeNull();

      await plan.setNickname("Option A");
      await expect(plan.addNicknameButton()).toHaveText("“Option A” (rename)");
      expect((await current()).label).toBe("Option A");

      await plan.setNickname("Option B");
      await expect.poll(async () => (await current()).label).toBe("Option B");

      const v = await current();
      const theirs = await context.request.patch(`/api/v1/weddings/${w}/plan-versions/${v.id}`, {
        data: { label: "Theirs", expectedRevision: v.revision },
      });
      expect(theirs.ok()).toBe(true);
      await plan.setNickname("Mine");
      await expect(plan.message(/^This plan changed since you loaded it — someone else's change landed first\./)).toBeVisible();
      expect((await current()).label).toBe("Theirs");
      await plan.cancelNicknameEdit();
    });

    await test.step("Two versions can be compared, and a version can't be compared with itself", async () => {
      await plan.openComparison();
      await plan.compare();
      await expect(plan.comparisonSummary()).toBeVisible();
      await plan.compare(/^v1\b/, /^v1\b/);
      await expect(plan.message("Choose two different plan versions to compare.")).toBeVisible();
    });

    await test.step("Status: In review back to Draft, and Approved reopened for review", async () => {
      await plan.moveToReview();
      await plan.moveBackToDraft();
      await expect.poll(async () => (await current()).status).toBe("DRAFT");

      await plan.moveToReview();
      await plan.approve();
      await expect.poll(async () => (await current()).status).toBe("APPROVED");
      await plan.reopenForReview();
      await expect.poll(async () => (await current()).status).toBe("IN_REVIEW");
    });

    await test.step("A past version is read-only, and its restore previews, cancels and confirms", async () => {
      await plan.selectVersion(/^v1\b/);
      await expect(plan.pastVersionNotice()).toBeVisible();
      await expect(plan.statusChangeButtons()).toHaveCount(0);

      await plan.restoreButton(1).click();
      await expect(plan.restorePreview(1)).toBeVisible();
      await plan.cancelRestore();
      await expect(plan.restorePreview(1)).toHaveCount(0);
      expect(await versions()).toHaveLength(2);

      await plan.restoreButton(1).click();
      await plan.confirmRestore();
      await expect.poll(async () => (await versions()).length).toBe(3);
      const restored = await current();
      expect(restored.versionNumber).toBe(3);
      await expect(plan.pastVersionNotice()).toHaveCount(0);
    });
  },
);
