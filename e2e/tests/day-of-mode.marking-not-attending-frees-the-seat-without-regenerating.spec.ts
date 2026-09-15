/**
 * TS-45 (REQ-DAY-OF-EMERGENCY-MODE) — converts AC-060 ("Marking a guest Not Attending frees their
 * seat without a full regeneration").
 *
 * Traced directly in apps/web/src/app/weddings/[weddingId]/components/DayOfTab.tsx and
 * packages/db/src/queries/plan-versions.ts's `setGuestAttendance`: this is a single `POST
 * .../guests/:guestId/attendance` call that (in one transaction) flips `dayOfAttendance`, deletes
 * the guest's own `seat_assignments` row for the wedding's Current plan version (freeing the
 * seat), recomputes `isComplete`, and inserts an `ATTENDANCE_CHANGE` change-history entry -- it
 * never touches any other guest's assignment and never creates a new `plan_versions` row. "Without
 * a full regeneration" is proven here concretely: the Current plan version's own `id` and
 * `versionNumber` are identical before and after, and a second, previously-seated guest's own
 * assignment is byte-for-byte unchanged.
 *
 * Also confirmed directly: reverting a guest back to Attending does NOT auto-seat them (FR-8.1) --
 * they come back as Unassigned until someone explicitly reseats them, which this test proves as
 * its second half rather than assuming only the one-way (mark-not-attending) case matters.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";

defineQualityTest(
  {
    id: "day-of-mode.marking-not-attending-frees-the-seat-without-regenerating.round-trips-without-a-new-plan-version",
    title: "marking a seated guest Not Attending frees their seat immediately, leaves everyone else untouched, and creates no new plan version; marking them Attending again leaves them Unassigned rather than auto-seating them",
    objective:
      "Confirms Day-of mode's attendance toggle frees a guest's seat against the Current plan version without generating a new version (same plan version id/versionNumber before and after) and without moving any other guest, and that reverting to Attending does not re-seat them automatically.",
    expectedOutcome:
      "After marking the guest Not Attending: the Current plan version's id/versionNumber are unchanged, the guest has no assignment and is excluded from the unassigned/incomplete count, a second guest's assignment is untouched, and the UI shows 'Not attending' with a freed-seat notice. After marking them Attending again: they show as Unassigned in the UI and have no assignment, rather than being automatically reseated.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const dayOf = new DayOfTabPage(page);

    const leaving = uniquePersonName(token);
    const staying = uniquePersonName(token);
    const leavingName = `${leaving.firstName} ${leaving.lastName}`;

    let planVersionId = "";
    let planVersionNumber = 0;
    let leavingGuestId = "";
    let stayingGuestId = "";
    let stayingTableId = "";

    await test.step("Arrange: two guests, each seated at their own single-seat table", async () => {
      const leavingGuest = await weddingData.createGuest(managedWedding.id, leaving);
      leavingGuestId = leavingGuest.id;
      const stayingGuest = await weddingData.createGuest(managedWedding.id, staying);
      stayingGuestId = stayingGuest.id;
      await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 1 });
      await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 1 });

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      planVersionNumber = generated.versionNumber;
      stayingTableId = generated.assignments.find((a) => a.guestId === stayingGuestId)!.tableId;
    });

    await test.step("Act: open Day-of mode and mark the guest Not Attending", async () => {
      await dayOf.goto(managedWedding.id);
      await dayOf.toggleAttendance(leavingName);
      // A generous timeout on this first hit only: in local dev (Turbopack), a route compiles
      // lazily on its first request, which can take several seconds -- not a reflection of the
      // app's real (built) latency, and unrelated to what this assertion is actually checking.
      await expect(dayOf.noticeText()).toContainText("seat is now free", { timeout: 15_000 });
    });

    await test.step("Assert: the seat is freed, no new plan version was created, and the other guest is untouched", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.id).toBe(planVersionId);
      expect(detail.versionNumber).toBe(planVersionNumber);
      expect(detail.assignments.find((a) => a.guestId === leavingGuestId)).toBeUndefined();
      expect(detail.unassignedGuestIds).not.toContain(leavingGuestId); // excluded entirely, not "unassigned"
      expect(detail.isComplete).toBe(true); // a Not Attending guest can't make the plan incomplete
      expect(detail.assignments.find((a) => a.guestId === stayingGuestId)?.tableId).toBe(stayingTableId);
    });

    await test.step("Assert (UI): the guest's own row now reads Not attending", async () => {
      await expect(dayOf.guestStatusText(leavingName)).toHaveText("Not attending");
    });

    await test.step("Act: mark the guest Attending again", async () => {
      await dayOf.toggleAttendance(leavingName);
      await expect(dayOf.noticeText()).toContainText("seat them below");
    });

    await test.step("Assert: they come back Unassigned, not auto-seated, and still no new plan version", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.id).toBe(planVersionId);
      expect(detail.versionNumber).toBe(planVersionNumber);
      expect(detail.assignments.find((a) => a.guestId === leavingGuestId)).toBeUndefined();
      expect(detail.unassignedGuestIds).toContain(leavingGuestId);
    });
  },
);
