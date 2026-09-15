/**
 * TS-44 (REQ-MANUAL-ADJUSTMENT) — converts AC-053 ("Drag a guest between tables on the Current
 * Plan Version's floor plan"), AC-054 ("A drag that would violate a hard rule is blocked, exactly
 * as a direct move is"), and AC-055 ("A drag that only conflicts with a soft preference completes,
 * with a warning").
 *
 * The drag gesture itself (traced directly in
 * apps/web/src/app/weddings/[weddingId]/components/PlanTab.tsx's `PlanFloorPlan`) is genuine
 * native HTML5 drag-and-drop: `onGuestDragStart` calls `dataTransfer.setData("text/plain",
 * guestId)`, and `onTableDrop` reads it back via `dataTransfer.getData(...)` and calls the exact
 * same `onMoveGuest(guestId, tableId)` handler the list view's "Move to..." dropdowns call — so
 * the drag is a different UI gesture triggering the identical `POST .../assignments` endpoint,
 * confirmed empirically against the running app before writing these assertions (a guest chip has
 * no `data-testid`, only `data-guest-id`/`data-table-id`, which is how
 * `PlanTabPage.dragGuestToTable` selects both ends).
 *
 * AC-054 exercises exactly one representative hard-rule violation (capacity) via the drag gesture
 * rather than re-proving all six hard-rule scenarios: those are already fully covered, at the API
 * level, by cross-cutting-invariant.hard-rules-block-every-direct-manual-move.spec.ts (TS-54),
 * which explicitly notes in its own header that the drag gesture itself was left for this story.
 * The endpoint enforces the same rule regardless of which UI gesture calls it (the same
 * `moveGuestAssignment` code path either way), so one representative scenario here is enough to
 * prove the *gesture* doesn't bypass anything -- it isn't re-establishing the rule itself.
 *
 * AC-055's literal wording implies any soft-preference conflict produces a warning. Empirically
 * confirmed (both here and previously for TS-42/AC-025): only an AVOID conflict produces one; a
 * PREFER_NEAR "conflict" (i.e., not actually being seated near the preferred guest) is silent by
 * design -- soft preferences influence generation but a manual move is never second-guessed
 * beyond the one AVOID-specific warning. This test proves both halves via the drag gesture: an
 * AVOID-conflicting drag shows the "That move was made, but note:" banner (confirmed verbatim in
 * PlanTab.tsx), and a subsequent PREFER_NEAR-conflicting drag in the same session shows no banner
 * at all (`moveWarnings` is replaced by the new move's own -- empty -- warnings array on every
 * move, so a stale banner from an earlier move could never linger and be mistaken for this one).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "manual-adjustment.drag-a-guest-between-tables.succeeds-blocks-hard-rule-and-warns-soft-rule",
    title: "dragging a guest onto a table moves them; dragging into a hard-rule violation is blocked with no change; dragging into an Avoid conflict succeeds with a warning, a Prefer-near drag does not",
    objective:
      "Confirms the floor plan's native drag-and-drop gesture drives the same manual-move endpoint as the list view's dropdowns: a valid drag relocates the guest (reflected in both the UI and the API), a drag that overfills a table is blocked with the same error a direct API call would get and leaves assignments unchanged, and a drag that only conflicts with an Avoid preference completes and shows the 'That move was made, but note:' warning banner (while a later Prefer-near drag shows no such banner).",
    expectedOutcome:
      "After a valid drag, the guest's chip appears inside the target table's box and the API confirms the new tableId. A drag onto an over-capacity table returns the same kind of blocking error a direct move would, and the guest's assignment (still unassigned) is unchanged. An Avoid-conflicting drag succeeds and displays the warning banner naming both guests; a later Prefer-near-conflicting drag in the same session succeeds with no warning banner shown.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const planTab = new PlanTabPage(page);
    let planVersionId = "";

    let guestId = "";
    let tableAId = "";
    let tableBId = "";
    let targetTableId = "";

    await test.step("Arrange (AC-053): one guest seated at one of two single-seat tables", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(token));
      guestId = guest.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Drag Table A", capacity: 1 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Drag Table B", capacity: 1 });
      tableAId = tableA.id;
      tableBId = tableB.id;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      const currentTable = generated.assignments.find((a) => a.guestId === guestId)?.tableId;
      targetTableId = currentTable === tableAId ? tableBId : tableAId;
    });

    await test.step("Act: open the Seating plan tab in Floor plan view", async () => {
      await planTab.goto(managedWedding.id);
      await planTab.showFloorPlanView();
    });

    await test.step("AC-053 — Act + Assert: dragging the guest's chip onto the other table box moves them", async () => {
      await planTab.dragGuestToTable(guestId, targetTableId);
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(targetTableId);
    });

    let fullTableId = "";
    let extraGuestId = "";
    let extraGuestName = "";
    await test.step("Arrange (AC-054): a second guest with nowhere to sit, and the now-full target table", async () => {
      // The target table from AC-053 now holds the first guest at its capacity of 1 -- exactly
      // the over-capacity fixture AC-054 needs, with no extra setup.
      fullTableId = targetTableId;
      const extra = uniquePersonName(token);
      const extraGuest = await weddingData.createGuest(managedWedding.id, extra);
      extraGuestId = extraGuest.id;
      extraGuestName = `${extra.firstName} ${extra.lastName}`;
    });

    await test.step("AC-054 — Act + Assert: dragging the unassigned guest onto the full table is blocked, unchanged", async () => {
      // A fresh navigation (rather than a raw reload) also re-lands on the Guests tab by
      // default, so `goto` re-selects the Seating plan tab exactly as the first visit did.
      await planTab.goto(managedWedding.id);
      await planTab.showFloorPlanView();
      await planTab.dragGuestToTable(extraGuestId, fullTableId);
      await expect(planTab.moveErrorText()).toContainText(extraGuestName);
      await expect(planTab.moveErrorText()).toContainText(/seat.*left|can't be seated/i);
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === extraGuestId)).toBeUndefined();
      expect(detail.unassignedGuestIds).toContain(extraGuestId);
    });

    let sharedTableId = "";
    let avoidGuestId = "";
    let avoidGuestName = "";
    let preferGuestId = "";
    await test.step("Arrange (AC-055): a roomy table holding one guest, an Avoid-conflicting guest, and a Prefer-near-conflicting guest", async () => {
      const shared = await weddingData.createTable(managedWedding.id, { label: "Shared Table", capacity: 5 });
      sharedTableId = shared.id;
      // extraGuestId (still unassigned from the AC-054 step) becomes the shared table's first
      // occupant -- reused rather than creating yet another guest, since its only role here is
      // "someone already seated there".
      await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, extraGuestId, sharedTableId);

      const avoid = uniquePersonName(token);
      const avoidGuest = await weddingData.createGuest(managedWedding.id, avoid);
      avoidGuestId = avoidGuest.id;
      avoidGuestName = `${avoid.firstName} ${avoid.lastName}`;
      await weddingData.createRelationship(managedWedding.id, extraGuestId, avoidGuestId, "AVOID");

      const prefer = uniquePersonName(token);
      const preferGuest = await weddingData.createGuest(managedWedding.id, prefer);
      preferGuestId = preferGuest.id;
      await weddingData.createRelationship(managedWedding.id, extraGuestId, preferGuestId, "PREFER_NEAR");
    });

    await test.step("AC-055 — Act + Assert: dragging the Avoid-conflicting guest onto the shared table succeeds and shows the warning banner", async () => {
      await planTab.goto(managedWedding.id);
      await planTab.showFloorPlanView();
      await planTab.dragGuestToTable(avoidGuestId, sharedTableId);
      await expect(planTab.moveWarningsBanner()).toBeVisible();
      await expect(planTab.moveWarningsBanner()).toContainText(avoidGuestName);
      await expect(planTab.moveWarningsBanner()).toContainText(extraGuestName);
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === avoidGuestId)?.tableId).toBe(sharedTableId);
    });

    await test.step("AC-055 — Act + Assert: dragging the Prefer-near-conflicting guest onto the same table succeeds with no warning banner", async () => {
      await planTab.dragGuestToTable(preferGuestId, sharedTableId);
      await expect(planTab.moveWarningsBanner()).not.toBeVisible();
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === preferGuestId)?.tableId).toBe(sharedTableId);
    });
  },
);
