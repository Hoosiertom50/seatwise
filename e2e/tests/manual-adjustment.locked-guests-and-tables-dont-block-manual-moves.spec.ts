/**
 * TS-44 (REQ-MANUAL-ADJUSTMENT) — converts AC-056 ("Locking a guest or a table doesn't prevent a
 * manual edit").
 *
 * `isLocked` (on both a guest and a table) is confirmed, by reading packages/db/src/queries/
 * plan-versions.ts's `moveGuestAssignment` and `unassignGuestFromPlan` directly, to be referenced
 * nowhere in either function -- the manual-move code path has no lock check of any kind. `isLocked`
 * is read only by packages/shared/src/seating-engine.ts, the *generation* algorithm: a locked
 * guest with a `currentTableId` is pinned to stay at their existing table across a regeneration,
 * and a locked table is excluded from the pool of candidate tables generation will place anyone at.
 * In other words, "locked" means "generation won't move this on its own" -- it has never meant
 * "an editor can't manually move it", and this test proves that distinction empirically rather
 * than relying on the source reading alone: a locked guest is manually dragged off their locked
 * home table, and a different guest is manually dragged onto that same locked table, both
 * succeeding exactly as an unlocked move would.
 *
 * `isLocked` can only be set at creation time through this app's API (confirmed -- there is no
 * PATCH route that can flip an existing guest's or table's lock flag), so both fixtures here are
 * created already locked rather than locked after the fact; that's sufficient to test the manual-
 * move code path, which is what this AC is actually about.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "manual-adjustment.locked-guests-and-tables-dont-block-manual-moves.drag-off-a-locked-guest-and-onto-a-locked-table",
    title: "a locked guest can still be manually dragged to a different table, and a locked table can still receive a manually-dragged guest",
    objective:
      "Confirms isLocked (on either a guest or a table) only ever affects the seat-assignment generation algorithm, never a manual drag-and-drop move: a guest created already locked, and already seated at a locked table, is successfully dragged to a different table; and a separate, unlocked guest is successfully dragged onto that same locked table.",
    expectedOutcome:
      "Both drags succeed (200, reflected in the UI and the API) exactly as they would for unlocked guests/tables -- neither the guest's own lock nor the table's lock blocks either direction of the move.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const planTab = new PlanTabPage(page);

    let planVersionId = "";
    let lockedGuestId = "";
    let lockedHomeTableId = "";
    let plainTargetTableId = "";
    let plainGuestId = "";

    await test.step("Arrange: a decoy guest/table pair to seed a Current plan version (generation refuses to run with zero guests/tables)", async () => {
      const decoyGuest = await weddingData.createGuest(managedWedding.id, uniquePersonName(token));
      plainGuestId = decoyGuest.id;
      const decoyTable = await weddingData.createTable(managedWedding.id, { label: "Decoy", capacity: 1 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      expect(generated.assignments.find((a) => a.guestId === plainGuestId)?.tableId).toBe(decoyTable.id);
    });

    await test.step("Arrange: a locked guest, a locked home table for them, and a plain target table -- placed entirely via manual moves, never generation", async () => {
      const lockedTable = await weddingData.createTable(managedWedding.id, {
        label: "Locked Home",
        capacity: 2,
        isLocked: true,
      });
      lockedHomeTableId = lockedTable.id;
      const plainTable = await weddingData.createTable(managedWedding.id, { label: "Plain Target", capacity: 2 });
      plainTargetTableId = plainTable.id;

      const lockedGuest = await weddingData.createGuest(managedWedding.id, {
        ...uniquePersonName(token),
        isLocked: true,
      });
      lockedGuestId = lockedGuest.id;

      const seat = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, lockedGuestId, lockedHomeTableId);
      expect(seat.status).toBe(200);
    });

    await test.step("Act: open the Seating plan tab in Floor plan view", async () => {
      await planTab.goto(managedWedding.id);
      await planTab.showFloorPlanView();
    });

    await test.step("Act + Assert: dragging the locked guest off their locked home table succeeds", async () => {
      await planTab.dragGuestToTable(lockedGuestId, plainTargetTableId);
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === lockedGuestId)?.tableId).toBe(plainTargetTableId);
    });

    await test.step("Act + Assert: dragging a different (plain) guest onto the now-vacated locked table succeeds", async () => {
      await planTab.dragGuestToTable(plainGuestId, lockedHomeTableId);
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === plainGuestId)?.tableId).toBe(lockedHomeTableId);
    });
  },
);
