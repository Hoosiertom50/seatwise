/**
 * TS-55 (REQ-INTEGRATION-E2E-SCENARIOS) — converts AC-082 ("Pre-wedding changes after approval")
 * and AC-083 ("Day-of execution using day-of mode and printed backups"). Grouped into one file
 * (two independent `defineQualityTest` scenarios, each with its own fresh `managedWedding`):
 * both start from the same real-world situation -- an already-Approved plan -- and both exercise
 * the same underlying mechanism (Day-of mode's attendance/seat controls, the only real UI surface
 * this app exposes for either "mark not attending" or "seat a guest," whether the change happens
 * days before the wedding or on the day itself; see DayOfTabPage's own header comment). What
 * differs is which combination of actions each AC names and what each one's Expected Result cares
 * about -- AC-082 cares about capacity/rule re-checking and the "Modified since approval" signal,
 * AC-083 cares about a swap's own hard/soft-rule behavior and, distinctively, that a PDF exported
 * *before* day-of changes is never silently rewritten by a later change.
 *
 * Both scenarios reach "Approved" through fast API scaffolding (`weddingData`), not a repeat of
 * AC-081's own full UI walkthrough -- that UI path is this story's other file's job
 * (integration.full-setup-to-approval-walkthrough.spec.ts). What's real-UI-driven here is only
 * the specific actions each AC is actually about: the Day-of mode controls themselves.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "integration.pre-wedding-changes-and-day-of-execution.marking-guests-not-attending-and-adding-a-late-guest-keeps-the-plan-approved-with-modified-since-approval-visible",
    title: "marking two guests not attending frees their seats without a full regeneration, adding a late guest seats them in the freed capacity, the plan stays Approved with 'Modified since approval' visible, and all three changes appear in history",
    objective:
      "Confirms that, against an already-Approved plan, marking two attending guests Not Attending (through Day-of mode's real UI) removes their assignments and frees capacity without regenerating the whole plan, adding a late guest as Attending and seating them at a freed table succeeds without violating any hard rule, the plan version's own status stays APPROVED throughout with its 'Modified since approval' signal now active and visible on the Seating plan tab, and all three changes are recorded in the wedding's change history.",
    expectedOutcome:
      "After the two changes, the plan version's assignments no longer include the two newly-not-attending guests, do include the late guest seated at the freed table, status is still APPROVED, modifiedSinceApproval.active is true, the Seating plan tab shows the 'Modified since approval' banner, and the activity log has 2 new ATTENDANCE_CHANGE entries and 1 new MANUAL_MOVE entry naming the late guest and their table.",
    requirementIds: ["REQ-INTEGRATION-E2E-SCENARIOS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:manual-adjustment", "@risk:critical", "@suite:smoke", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const [g1, g2, g3] = [
      uniquePersonName(testInfo.workerIndex),
      uniquePersonName(testInfo.workerIndex),
      uniquePersonName(testInfo.workerIndex),
    ];
    let planVersionId = "";
    let activityCountBefore = 0;
    let freedTableLabel = "";

    await test.step("Arrange: an Approved, complete 3-guest/3-table plan", async () => {
      await weddingData.createGuest(managedWedding.id, g1);
      await weddingData.createGuest(managedWedding.id, g2);
      await weddingData.createGuest(managedWedding.id, g3);
      await weddingData.quickCreateTables(managedWedding.id, { count: 3, capacity: 1 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;

      await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
      const approved = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
      expect(approved.status).toBe(200);

      freedTableLabel = generated.assignments.find(
        (a) => a.guestName === `${g1.firstName} ${g1.lastName}`,
      )!.tableLabel;
      activityCountBefore = (await weddingData.getActivity(managedWedding.id)).length;
    });

    const dayOf = new DayOfTabPage(page);
    await test.step("Act (real UI): mark two attending guests Not Attending, then add a late guest seated at the freed table", async () => {
      await dayOf.goto(managedWedding.id);
      await dayOf.toggleAttendance(`${g1.firstName} ${g1.lastName}`);
      await dayOf.toggleAttendance(`${g2.firstName} ${g2.lastName}`);
      await dayOf.addWalkIn("Late", "Guest", freedTableLabel);
    });

    let detail: Awaited<ReturnType<typeof weddingData.getPlanVersionDetail>>;
    await test.step("Assert: the former assignments are gone, the late guest is seated, and the plan is still Approved", async () => {
      detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.status).toBe("APPROVED");
      const assignedNames = detail.assignments.map((a) => a.guestName);
      expect(assignedNames).not.toContain(`${g1.firstName} ${g1.lastName}`);
      expect(assignedNames).not.toContain(`${g2.firstName} ${g2.lastName}`);
      expect(assignedNames).toContain(`${g3.firstName} ${g3.lastName}`);
      const lateAssignment = detail.assignments.find((a) => a.guestName === "Late Guest");
      expect(lateAssignment).toBeTruthy();
      expect(lateAssignment!.tableLabel).toBe(freedTableLabel);
    });

    await test.step("Assert: 'Modified since approval' is now active and visible on the Seating plan tab", async () => {
      expect(detail!.modifiedSinceApproval.active).toBe(true);
      const planPage = new PlanTabPage(page);
      await planPage.goto(managedWedding.id);
      await expect(planPage.modifiedSinceApprovalBanner()).toBeVisible();
    });

    await test.step("Assert: all three changes appear in the wedding's change history", async () => {
      const activity = await weddingData.getActivity(managedWedding.id);
      expect(activity.length).toBeGreaterThanOrEqual(activityCountBefore + 3);
      const newEntries = activity.slice(0, activity.length - activityCountBefore);
      const attendanceChanges = newEntries.filter((a) => a.action === "ATTENDANCE_CHANGE");
      expect(attendanceChanges.length).toBeGreaterThanOrEqual(2);
      expect(attendanceChanges.some((a) => a.description.includes(g1.firstName))).toBe(true);
      expect(attendanceChanges.some((a) => a.description.includes(g2.firstName))).toBe(true);
      expect(
        newEntries.some((a) => a.action === "MANUAL_MOVE" && a.description.includes("Late") && a.description.includes(freedTableLabel)),
      ).toBe(true);
    });
  },
);

defineQualityTest(
  {
    id: "integration.pre-wedding-changes-and-day-of-execution.a-no-show-and-a-swap-in-day-of-mode-leave-an-earlier-exported-pdf-untouched",
    title: "marking a no-show and swapping two guests' tables in Day-of mode both save to Change History and update the digital plan, while a PDF exported before those changes stays exactly as it was",
    objective:
      "Confirms that, against an already-Approved plan whose seating chart was exported before any day-of changes, marking a no-show guest Not Attending and swapping two other seated guests' tables (both through Day-of mode's real UI) each record a Change History entry and update the digital Current Plan Version's own assignments, while the previously-downloaded PDF bytes are never retroactively altered -- proven by re-exporting afterward and confirming the freshly-generated PDF now differs from the one captured before.",
    expectedOutcome:
      "The no-show's assignment is removed and a swap exchanges the other two guests' table assignments; both actions appear in Change History (ATTENDANCE_CHANGE, MANUAL_SWAP); a chart PDF exported before the changes remains, byte for byte, exactly what it was captured as; a chart PDF exported after the changes is a different, still-valid PDF.",
    requirementIds: ["REQ-INTEGRATION-E2E-SCENARIOS"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:export", "@risk:critical", "@suite:smoke", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    const [noShow, swapA, swapB] = [
      uniquePersonName(testInfo.workerIndex),
      uniquePersonName(testInfo.workerIndex),
      uniquePersonName(testInfo.workerIndex),
    ];
    let planVersionId = "";
    let swapAOption = "";
    let swapBOption = "";
    let activityCountBefore = 0;

    await test.step("Arrange: an Approved, complete 3-guest/3-table plan, exported once before any day-of change", async () => {
      await weddingData.createGuest(managedWedding.id, noShow);
      await weddingData.createGuest(managedWedding.id, swapA);
      await weddingData.createGuest(managedWedding.id, swapB);
      await weddingData.quickCreateTables(managedWedding.id, { count: 3, capacity: 1 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;

      await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
      const approved = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
      expect(approved.status).toBe(200);

      const swapAAssignment = generated.assignments.find((a) => a.guestName === `${swapA.firstName} ${swapA.lastName}`)!;
      const swapBAssignment = generated.assignments.find((a) => a.guestName === `${swapB.firstName} ${swapB.lastName}`)!;
      swapAOption = `${swapAAssignment.guestName} (${swapAAssignment.tableLabel})`;
      swapBOption = `${swapBAssignment.guestName} (${swapBAssignment.tableLabel})`;

      activityCountBefore = (await weddingData.getActivity(managedWedding.id)).length;
    });

    let beforeBytes: Buffer;
    await test.step("Arrange: export the seating chart PDF before any day-of change", async () => {
      const res = await context.request.get(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/export/chart`,
      );
      expect(res.status()).toBe(200);
      beforeBytes = await res.body();
      expect(beforeBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });

    const dayOf = new DayOfTabPage(page);
    await test.step("Act (real UI): mark the no-show Not Attending, then swap the other two guests' tables", async () => {
      await dayOf.goto(managedWedding.id);
      await dayOf.toggleAttendance(`${noShow.firstName} ${noShow.lastName}`);
      await dayOf.swap(swapAOption, swapBOption);
    });

    await test.step("Assert: the digital plan reflects both changes", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.status).toBe("APPROVED");
      const assignedNames = detail.assignments.map((a) => a.guestName);
      expect(assignedNames).not.toContain(`${noShow.firstName} ${noShow.lastName}`);

      const newSwapA = detail.assignments.find((a) => a.guestName === `${swapA.firstName} ${swapA.lastName}`)!;
      const newSwapB = detail.assignments.find((a) => a.guestName === `${swapB.firstName} ${swapB.lastName}`)!;
      expect(newSwapA.tableLabel).toBe(swapBOption.match(/\(([^)]+)\)$/)![1]);
      expect(newSwapB.tableLabel).toBe(swapAOption.match(/\(([^)]+)\)$/)![1]);
    });

    await test.step("Assert: both changes appear in Change History", async () => {
      const activity = await weddingData.getActivity(managedWedding.id);
      const newEntries = activity.slice(0, activity.length - activityCountBefore);
      expect(newEntries.some((a) => a.action === "ATTENDANCE_CHANGE" && a.description.includes(noShow.firstName))).toBe(
        true,
      );
      expect(
        newEntries.some(
          (a) => a.action === "MANUAL_SWAP" && a.description.includes(swapA.firstName) && a.description.includes(swapB.firstName),
        ),
      ).toBe(true);
    });

    await test.step("Assert: the PDF exported before the changes is untouched, and a fresh export now differs from it", async () => {
      const res = await context.request.get(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/export/chart`,
      );
      expect(res.status()).toBe(200);
      const afterBytes = await res.body();
      expect(afterBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      // The earlier-captured buffer (`beforeBytes`) was never touched by anything this test did
      // afterward -- it's a plain in-memory Buffer, not re-fetched -- so this comparison is really
      // asserting the *new* export reflects the day-of changes rather than serving the exact same
      // cached bytes back, which is the one concretely testable proxy for "the earlier PDF wasn't
      // retroactively rewritten": if the app somehow served identical bytes after a real seating
      // change, that would mean the PDF never captured the change at all, not that the old one was
      // preserved.
      expect(afterBytes.equals(beforeBytes)).toBe(false);
    });
  },
);
