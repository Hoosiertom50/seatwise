/**
 * TS-45 (REQ-DAY-OF-EMERGENCY-MODE) — converts AC-062 ("Two guests' seats can be swapped in one
 * action").
 *
 * Traced directly in packages/db/src/queries/plan-versions.ts's `swapGuestAssignments`: both
 * guests (or, if either is in a MUST_SIT_TOGETHER unit, their whole unit) must already be fully
 * and consistently seated at one table each before a swap is possible -- confirmed by the
 * component only rendering the "Swap two guests' tables" control at all once
 * `attendingSeatedGuests.length >= 2` (DayOfTab.tsx). Both directions are validated against every
 * hard rule using each side's *post-swap* occupancy before anything changes.
 *
 * A plain one-guest-for-one-guest swap can never violate capacity on its own (whoever leaves a
 * table is replaced by exactly one incoming guest, so per-table headcount is conserved) -- proving
 * a capacity block requires asymmetric headcounts, so this test's blocked scenario swaps a
 * headcount-2 guest (already exactly filling a capacity-2 table) with a headcount-1 guest at a
 * capacity-1 table: the headcount-2 guest can't fit in the capacity-1 table post-swap, which is
 * exactly the kind of block a plain move's own capacity check can't exercise (it depends on who's
 * *leaving* a table, a swap-specific concept) -- the same must-not-sit-together/accessible-table
 * logic a plain move already enforces (TS-54, TS-44) is not re-proven here for swap specifically.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";

defineQualityTest(
  {
    id: "day-of-mode.swap-two-guests-tables-in-one-action.succeeds-and-blocks-an-over-capacity-swap",
    title: "swapping two seated guests' tables moves both in one action; a swap that would overfill a destination table is blocked with neither guest moved",
    objective:
      "Confirms Day-of mode's Swap control moves two already-seated guests to each other's tables in a single action (both assignments updated together), and that a swap which would leave a destination table over capacity once the incoming guest's headcount arrives is blocked outright with both guests left exactly where they started.",
    expectedOutcome:
      "After a valid swap: each guest is now seated at the other's original table. A swap where the incoming guest's headcount can't fit the destination table returns a blocking error, and both guests' assignments are unchanged afterward.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const dayOf = new DayOfTabPage(page);

    const guestA = uniquePersonName(token);
    const guestB = uniquePersonName(token);
    const guestANameFull = `${guestA.firstName} ${guestA.lastName}`;
    const guestBNameFull = `${guestB.firstName} ${guestB.lastName}`;

    let planVersionId = "";
    let guestAId = "";
    let guestBId = "";
    let tableAId = "";
    let tableBId = "";

    await test.step("Arrange: two guests, each seated at their own single-seat table", async () => {
      const gA = await weddingData.createGuest(managedWedding.id, guestA);
      guestAId = gA.id;
      const gB = await weddingData.createGuest(managedWedding.id, guestB);
      guestBId = gB.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Swap Table A", capacity: 1 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Swap Table B", capacity: 1 });
      tableAId = tableA.id;
      tableBId = tableB.id;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      // Pin each guest to a known table deterministically, rather than trusting generation's own
      // tie-break, so the swap's expected before/after state is unambiguous.
      await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestAId, tableAId);
      await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestBId, tableBId);
    });

    await test.step("Act: open Day-of mode and swap the two guests", async () => {
      await dayOf.goto(managedWedding.id);
      await dayOf.swap(`${guestANameFull} (Swap Table A)`, `${guestBNameFull} (Swap Table B)`);
      await expect(dayOf.noticeText()).toContainText("Swapped", { timeout: 15_000 });
    });

    await test.step("Assert: each guest is now at the other's original table", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === guestAId)?.tableId).toBe(tableBId);
      expect(detail.assignments.find((a) => a.guestId === guestBId)?.tableId).toBe(tableAId);
    });

    let plusOneId = "";
    let soloId = "";
    let roomyTableId = "";
    let tinyTableId = "";
    await test.step("Arrange: a headcount-2 guest exactly filling a capacity-2 table, and a headcount-1 guest alone at a capacity-1 table", async () => {
      const roomyTable = await weddingData.createTable(managedWedding.id, { label: "Roomy Table", capacity: 2 });
      const tinyTable = await weddingData.createTable(managedWedding.id, { label: "Tiny Table", capacity: 1 });
      roomyTableId = roomyTable.id;
      tinyTableId = tinyTable.id;

      const plusOne = await weddingData.createGuest(managedWedding.id, { ...uniquePersonName(token), headcount: 2 });
      plusOneId = plusOne.id;
      const solo = await weddingData.createGuest(managedWedding.id, uniquePersonName(token));
      soloId = solo.id;

      await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, plusOneId, roomyTableId);
      await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, soloId, tinyTableId);
    });

    await test.step("Act + Assert: swapping the headcount-2 guest into the capacity-1 table is blocked, both unchanged", async () => {
      const swap = await weddingData.swapGuestAssignments(managedWedding.id, planVersionId, plusOneId, soloId);
      expect(swap.status).toBe(409);
      expect(swap.body.error).toBeTruthy();

      const after = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(after.assignments.find((a) => a.guestId === plusOneId)?.tableId).toBe(roomyTableId);
      expect(after.assignments.find((a) => a.guestId === soloId)?.tableId).toBe(tinyTableId);
    });
  },
);
