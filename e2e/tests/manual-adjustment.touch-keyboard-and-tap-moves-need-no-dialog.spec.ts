/**
 * TS-90 (REQ-MANUAL-ADJUSTMENT, REQ-NON-FUNCTIONAL) — guest-to-table assignment on the floor plan
 * must be direct for every input, not a multi-step dialog flow.
 *
 * Mouse drag (native HTML5 DnD) is already covered by
 * manual-adjustment.drag-a-guest-between-tables.spec.ts. Before TS-90 that was the *only* way the
 * floor plan could move a guest: native HTML5 drag never fires for a finger on most touch
 * browsers, and neither the chips nor the table boxes were keyboard-operable -- so a planner on a
 * tablet, or using a keyboard, had to leave the floor plan for the list view's dropdowns. This
 * covers the three paths TS-90 added, each through the real UI and each confirmed against the API:
 *
 * - a finger drag (touch PointerEvents),
 * - keyboard pick-and-place (Enter on a guest, Tab to a table, Enter), plus Escape cancelling,
 * - tap/click pick-and-place (tap a guest, tap a table).
 *
 * Tables are given explicit, non-overlapping positions: the touch path finds its drop target with
 * elementFromPoint, and unpositioned tables all default to the same spot.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "manual-adjustment.touch-keyboard-and-tap-moves-need-no-dialog.every-input-moves-directly",
    title: "on the floor plan a guest can be moved to a table by finger drag, by keyboard, or by tap — each directly, with no dialog — and Escape cancels a keyboard pick-up",
    objective:
      "Confirms the floor plan's touch drag, keyboard pick-and-place, and tap pick-and-place each move a guest to the chosen table in one direct gesture through the same move endpoint as every other manual move, and that Escape cancels a keyboard pick-up without moving anyone.",
    expectedOutcome:
      "After each of the touch drag, keyboard move, and tap move, the API shows the guest at the chosen table. After picking up with Enter and pressing Escape, the chip is no longer picked up and the guest's table is unchanged.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    const planTab = new PlanTabPage(page);
    let planVersionId = "";
    let guestId = "";
    let tableAId = "";
    let tableBId = "";

    const tableOf = async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      return detail.assignments.find((a) => a.guestId === guestId)?.tableId;
    };

    await test.step("Arrange: one guest seated at one of two roomy, well-separated tables", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestId = guest.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Touch Table A", capacity: 4 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Touch Table B", capacity: 4 });
      tableAId = tableA.id;
      tableBId = tableB.id;
      for (const [id, x] of [
        [tableAId, 40],
        [tableBId, 400],
      ] as const) {
        const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/tables/${id}`, {
          data: { positionX: x, positionY: 40 },
        });
        expect(res.ok()).toBe(true);
      }
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      planVersionId = generated.id;
      expect(await tableOf()).toBeTruthy();
    });

    const other = (tableId: string | undefined) => (tableId === tableAId ? tableBId : tableAId);

    await test.step("Act: open the Seating plan tab in Floor plan view", async () => {
      await planTab.goto(managedWedding.id);
      await planTab.showFloorPlanView();
    });

    await test.step("Act + Assert: a finger drag onto the other table moves the guest", async () => {
      const target = other(await tableOf());
      await planTab.touchDragGuestToTable(guestId, target);
      expect(await tableOf()).toBe(target);
    });

    await test.step("Act + Assert: keyboard pick-and-place (Enter, Tab to the table, Enter) moves the guest", async () => {
      const target = other(await tableOf());
      await planTab.keyboardMoveGuestToTable(guestId, target);
      expect(await tableOf()).toBe(target);
    });

    await test.step("Act + Assert: Escape cancels a keyboard pick-up and moves no one", async () => {
      const before = await tableOf();
      await planTab.keyboardPickUpThenCancel(guestId);
      await expect(planTab.guestChipFor(guestId)).toHaveAttribute("aria-pressed", "false");
      expect(await tableOf()).toBe(before);
    });

    await test.step("Act + Assert: tapping the guest and then the other table moves the guest", async () => {
      const target = other(await tableOf());
      await planTab.tapMoveGuestToTable(guestId, target);
      expect(await tableOf()).toBe(target);
    });
  },
);
