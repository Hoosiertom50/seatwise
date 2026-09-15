/**
 * TS-45 (REQ-DAY-OF-EMERGENCY-MODE) — converts AC-061 ("A walk-in guest can be added and seated
 * without a full regeneration").
 *
 * Traced directly in DayOfTab.tsx's `onAddWalkIn`: it's two plain, already-existing calls in
 * sequence -- `POST .../guests` (creating a new guest with `headcount: 1,
 * dayOfAttendance: "ATTENDING"`) and, only if a table was chosen, the same manual-move
 * `POST .../plan-versions/:id/assignments` endpoint TS-44 exercises directly. Neither call creates
 * a new plan version -- the walk-in lands in the Current one, proven here the same way as AC-060:
 * the plan version's own id/versionNumber are unchanged before and after. This test covers both of
 * the form's real paths: seating the walk-in immediately (a table chosen), and leaving them
 * unassigned for now (no table chosen, confirmed the guest still exists and is seatable afterward
 * from the same tab's own guest-list "Seat at..." control).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";

defineQualityTest(
  {
    id: "day-of-mode.add-and-seat-a-walk-in-without-regenerating.seats-immediately-or-leaves-them-for-later",
    title: "adding a walk-in and seating them immediately works in one action with no new plan version; adding one without a table leaves them findable and seatable later from the same tab",
    objective:
      "Confirms Day-of mode's 'Add a walk-in' form creates a new, already-Attending guest and, when a table is chosen, seats them at it in the same action -- all against the existing Current plan version, never creating a new one. Also confirms a walk-in added without choosing a table is left Unassigned but fully usable: seatable from the same tab afterward.",
    expectedOutcome:
      "After adding a walk-in with a table chosen: a new guest exists, is seated at that table in the Current plan version (same id/versionNumber as before), and a confirming notice is shown. After adding a second walk-in with no table chosen: that guest exists, is Unassigned, and can then be seated from the guest list's own 'Seat at...' control.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const dayOf = new DayOfTabPage(page);
    const token = testInfo.workerIndex;
    // Guest names are constrained by the app's own PERSON_NAME_PATTERN (letters only, no
    // digits) -- uniqueToken encodes uniqueness as letters for exactly this reason (see
    // e2e/data/ids.ts), unlike a raw Date.now()-based suffix which would 422.
    const suffix = uniqueToken(token);

    let planVersionId = "";
    let planVersionNumber = 0;
    let tableAId = "";
    const tableALabel = "Walk-in Table A";
    const tableBLabel = "Walk-in Table B";

    await test.step("Arrange: two single-seat tables and a Current plan version with a decoy guest occupying neither", async () => {
      const tableA = await weddingData.createTable(managedWedding.id, { label: tableALabel, capacity: 1 });
      tableAId = tableA.id;
      await weddingData.createTable(managedWedding.id, { label: tableBLabel, capacity: 1 });
      const decoyTable = await weddingData.createTable(managedWedding.id, { label: "Decoy", capacity: 1 });
      await weddingData.createGuest(managedWedding.id, uniquePersonName(token));

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      planVersionNumber = generated.versionNumber;
      // The decoy fills the decoy table exactly, confirming it never touches either Walk-in table.
      expect(generated.assignments.every((a) => a.tableId !== tableAId)).toBe(true);
      void decoyTable;
    });

    await test.step("Act: open Day-of mode and add a walk-in, seated immediately at Table A", async () => {
      await dayOf.goto(managedWedding.id);
      await dayOf.addWalkIn("Walkin", `Seated${suffix}`, tableALabel);
      // A generous timeout on this first hit only: in local dev (Turbopack), a route compiles
      // lazily on its first request, which can take several seconds and is unrelated to what
      // this assertion actually checks.
      await expect(dayOf.noticeText()).toContainText("Added walk-in Walkin Seated", { timeout: 15_000 });
      await expect(dayOf.noticeText()).toContainText("seated them");
    });

    await test.step("Assert: the walk-in is seated at Table A in the same Current plan version -- no new version created", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.id).toBe(planVersionId);
      expect(detail.versionNumber).toBe(planVersionNumber);
      const seated = detail.assignments.find((a) => a.guestName === `Walkin Seated${suffix}`);
      expect(seated?.tableId).toBe(tableAId);
    });

    await test.step("Act: add a second walk-in with no table chosen", async () => {
      await dayOf.addWalkIn("Walkin", `Unassigned${suffix}`);
      await expect(dayOf.noticeText()).toContainText("not yet seated");
    });

    await test.step("Assert: the second walk-in exists, is Unassigned, and can be seated from the same tab", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.id).toBe(planVersionId); // still no new plan version
      expect(detail.assignments.find((a) => a.guestName === `Walkin Unassigned${suffix}`)).toBeUndefined();

      await dayOf.seatGuestAt(`Walkin Unassigned${suffix}`, tableBLabel);
      await expect(async () => {
        const after = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
        expect(after.assignments.find((a) => a.guestName === `Walkin Unassigned${suffix}`)?.tableLabel).toBe(
          tableBLabel,
        );
        expect(after.id).toBe(planVersionId);
      }).toPass();
    });
  },
);
