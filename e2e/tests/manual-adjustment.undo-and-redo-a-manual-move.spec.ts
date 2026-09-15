/**
 * TS-44 (REQ-MANUAL-ADJUSTMENT) — converts AC-057 ("A manual move can be undone and redone within
 * the current editing session").
 *
 * Traced directly in apps/web/src/app/weddings/[weddingId]/components/PlanTab.tsx: undo/redo is
 * deliberately plain, non-persisted React component state (`undoStack`/`redoStack`, each a stack
 * of `{guestId, priorTableId, toTableId, description}`), reset on generate/version-switch/restore
 * and never reloaded from anywhere -- so it is unavailable after a page reload by construction,
 * not by an explicit check, which this test proves directly rather than assuming. `onUndo`/`onRedo`
 * each do their own fresh `GET` staleness pre-check (confirming the guest is still exactly where
 * this stack entry left them) before replaying the move through the *same*
 * `POST .../assignments` endpoint a fresh move uses -- but, confirmed by reading the code, that
 * replay POST does NOT pass `expectedRevision` at all (unlike every other write in this file),
 * relying solely on the separate pre-check instead. That's a real, deliberate asymmetry worth
 * documenting, not a gap this test needs to close (AC-059 covers `expectedRevision` enforcement on
 * a fresh move; undo/redo's own staleness protection is the pre-check, by design).
 *
 * The Undo/Redo controls (`data-testid="undo-button"`/`"redo-button"`) render only once
 * `canEditThisVersion && (undoStack.length > 0 || redoStack.length > 0)` -- confirmed here too, by
 * asserting the row is entirely absent before any move is made.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "manual-adjustment.undo-and-redo-a-manual-move.round-trips-and-is-cleared-by-reload",
    title: "Undo reverses a manual move and Redo reapplies it, both within the same session; the controls are absent before any move and gone again after a reload",
    objective:
      "Confirms the Undo/Redo row is absent until at least one manual move has been made, that clicking Undo puts a guest back at their prior table (and Redo puts them back at the moved-to table), and that neither button nor any residual undo/redo state survives a page reload -- undo/redo is session-scoped only, per FR-7.5.",
    expectedOutcome:
      "No Undo/Redo controls are rendered before any move. After one drag-and-drop move, Undo is enabled and clicking it returns the guest to their prior table (both in the UI and via the API); Redo is then enabled and clicking it moves the guest back to the table the original move sent them to. After a page reload, the Undo/Redo row is gone even though the guest remains at their last (redone) table.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const planTab = new PlanTabPage(page);

    let planVersionId = "";
    let guestId = "";
    let priorTableId = "";
    let movedToTableId = "";

    await test.step("Arrange: one guest seated at one of two single-seat tables", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(token));
      guestId = guest.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Undo Table A", capacity: 1 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Undo Table B", capacity: 1 });

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      priorTableId = generated.assignments.find((a) => a.guestId === guestId)!.tableId;
      movedToTableId = priorTableId === tableA.id ? tableB.id : tableA.id;
    });

    await test.step("Act: open the Seating plan tab in Floor plan view", async () => {
      await planTab.goto(managedWedding.id);
      await planTab.showFloorPlanView();
    });

    await test.step("Assert: no Undo/Redo controls before any manual move this session", async () => {
      expect(await planTab.undoRedoRowVisible()).toBe(false);
    });

    await test.step("Act: drag the guest to the other table", async () => {
      await planTab.dragGuestToTable(guestId, movedToTableId);
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(movedToTableId);
    });

    await test.step("Act + Assert: Undo puts the guest back at their prior table", async () => {
      expect(await planTab.undoRedoRowVisible()).toBe(true);
      await planTab.undo();
      await expect(async () => {
        const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
        expect(detail.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(priorTableId);
      }).toPass();
    });

    await test.step("Act + Assert: Redo re-applies the original move", async () => {
      await planTab.redo();
      await expect(async () => {
        const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
        expect(detail.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(movedToTableId);
      }).toPass();
    });

    await test.step("Assert: after a page reload, the Undo/Redo row is gone even though the guest stays at their last (redone) table", async () => {
      await planTab.goto(managedWedding.id);
      expect(await planTab.undoRedoRowVisible()).toBe(false);
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(movedToTableId);
    });
  },
);
