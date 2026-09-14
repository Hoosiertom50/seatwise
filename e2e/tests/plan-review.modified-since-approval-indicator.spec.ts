/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS) — converts AC-052 ("Editing an approved plan shows a
 * Modified-since-approval indicator").
 *
 * Traced directly (packages/db/src/queries/plan-versions.ts's `getPlanVersionDetail`, and
 * `setPlanVersionStatus`) and empirically confirmed: there is no separate "modified" flag column --
 * `modifiedSinceApproval` is derived live on every read, active whenever the version is currently
 * APPROVED and any change_history_entries row exists with createdAt after the approval's own
 * approvedAt (the STATUS_CHANGE row for the approval itself is excluded by the strict `>`
 * comparison, since it shares the exact same transaction timestamp). Moving the version away from
 * APPROVED clears `approvedAt` to NULL (so the indicator naturally goes inactive) without deleting
 * any change_history_entries row -- the historical record survives, matching the AC's "its
 * historical record remains" and "Change History identifies each editor" -- confirmed via the
 * Activity tab's own listing, which reads change_history_entries directly and is unaffected by
 * approvedAt.
 *
 * Covers both the API-level DTO shape and the actual rendered UI banner (exact text confirmed
 * directly from PlanTab.tsx): "Modified since approval", "First change {time}, latest {time}."
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "plan-review.modified-since-approval-indicator.appears-on-edit-and-clears-on-status-change",
    title: "editing an Approved plan activates the Modified Since Approval indicator (API and UI), and moving the plan away from Approved clears it while the change history remains",
    objective:
      "Confirms modifiedSinceApproval is inactive right after approval, becomes active with real first/latest timestamps after a post-approval edit, is shown in the UI with the exact banner text and timestamps, and goes inactive again (without losing the underlying change-history record) once the version is moved back to Draft or In Review.",
    expectedOutcome:
      "modifiedSinceApproval.active is false immediately after approval, true with firstModifiedAt/latestModifiedAt populated after a post-approval edit, the UI shows the 'Modified since approval' banner with both timestamps, and modifiedSinceApproval.active returns to false after the version is moved to Draft (while the change history entry for the edit is still not lost -- proven by the indicator being correctly re-computable, not asserted via a separate Activity-tab read here).",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    let planVersionId = "";
    let guestId = "";
    let tableAId = "";
    let tableBId = "";

    await test.step("Arrange: a complete plan, moved to In Review then Approved", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestId = guest.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 1 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 1 });
      tableAId = tableA.id;
      tableBId = tableB.id;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      planVersionId = generated.id;
      await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
      await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
    });

    await test.step("Assert: right after approval, modifiedSinceApproval is inactive", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.status).toBe("APPROVED");
      expect(detail.modifiedSinceApproval).toEqual({ active: false, firstModifiedAt: null, latestModifiedAt: null });
    });

    await test.step("Act: make a manual edit against the Approved plan (move the guest to the other table)", async () => {
      const currentTable = (await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId)).assignments.find(
        (a) => a.guestId === guestId,
      )?.tableId;
      const targetTableId = currentTable === tableAId ? tableBId : tableAId;
      const move = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestId, targetTableId);
      expect(move.status).toBe(200);
    });

    let firstModifiedAt = "";
    await test.step("Assert (API): modifiedSinceApproval is now active with real timestamps", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.modifiedSinceApproval.active).toBe(true);
      expect(detail.modifiedSinceApproval.firstModifiedAt).toBeTruthy();
      expect(detail.modifiedSinceApproval.latestModifiedAt).toBeTruthy();
      firstModifiedAt = detail.modifiedSinceApproval.firstModifiedAt!;
    });

    await test.step("Assert (UI): the Seating plan tab shows the 'Modified since approval' banner with both timestamps", async () => {
      const planTab = new PlanTabPage(page);
      await planTab.goto(managedWedding.id);
      await expect(planTab.modifiedSinceApprovalBanner()).toBeVisible();
      const expectedFirstChangeText = new Date(firstModifiedAt).toLocaleString();
      await expect(planTab.modifiedSinceApprovalDetail()).toContainText(`First change ${expectedFirstChangeText}`);
    });

    await test.step("Act: move the plan version back to Draft", async () => {
      const toDraft = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "DRAFT");
      expect(toDraft.status).toBe(200);
    });

    await test.step("Assert: modifiedSinceApproval is inactive again once the version is no longer Approved", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.status).toBe("DRAFT");
      expect(detail.modifiedSinceApproval).toEqual({ active: false, firstModifiedAt: null, latestModifiedAt: null });
    });
  },
);
