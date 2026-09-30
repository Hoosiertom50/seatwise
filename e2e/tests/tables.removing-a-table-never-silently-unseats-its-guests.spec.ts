/**
 * TS-117 / TS-124 (REQ-TABLE-VENUE-LAYOUT, REQ-PLAN-REVIEW-STATUS) — removing a table takes every
 * seat at it with it, so it must never be silent about the guests seated there. Before TS-124 one
 * click on Remove unseated them all while the plan still read as complete and Approved.
 *
 * Now: an empty table removes in one click; a table with guests seated at it in the current plan
 * asks first (with the server's own count), "Keep table" changes nothing, and "Remove anyway"
 * leaves those guests listed as unassigned, the plan incomplete, an Approved plan flagged
 * "Modified since approval", and the removal recorded in the activity log.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "tables.removing-a-table-never-silently-unseats-its-guests.confirm-keep-remove-and-plan-state",
    title: "removing a table with seated guests asks first, keeping it changes nothing, and removing it anyway leaves the plan honestly incomplete and flagged -- while an empty table removes in one click",
    objective:
      "Confirms an empty table is removed without a prompt; that removing a table with guests seated at it in the current (Approved) plan shows a confirmation naming how many, that 'Keep table' leaves the table and plan untouched, and that 'Remove anyway' removes it and leaves those guests unassigned, the plan incomplete, 'Modified since approval' active, the removal in the activity log, and no 'Not saved' error; and that the API refuses an unconfirmed removal with 409.",
    expectedOutcome:
      "The empty table disappears with no prompt. Removing 'Table A' shows '2 guests are seated at \"Table A\" in the current plan…'. After Keep table, Table A and a complete Approved plan remain. After Remove anyway, Table A is gone, its two guests are in unassignedGuestIds, isComplete is false, modifiedSinceApproval.active is true, the activity log reads 'Table \"Table A\" removed — 2 guests left unassigned', and the save indicator shows no error. An unconfirmed DELETE of Table B returns 409 with seatedCount 1.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT", "REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:tables", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }, testInfo) => {
    const tablesTab = new TablesTabPage(page);
    const detailPage = new WeddingDetailPage(page);
    let planId = "";
    let seatedAtA: string[] = [];
    let tableBId = "";

    await test.step("Arrange: an Approved, complete plan -- two guests at Table A, one at Table B -- plus an empty table", async () => {
      for (let i = 0; i < 3; i++) await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      const a = await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 2 });
      const b = await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 1 });
      tableBId = b.id;
      const plan = await weddingData.generatePlanVersion(managedWedding.id);
      expect(plan.isComplete).toBe(true);
      planId = plan.id;
      seatedAtA = plan.assignments.filter((x) => x.tableId === a.id).map((x) => x.guestId).sort();
      expect(seatedAtA).toHaveLength(2);
      expect((await weddingData.setPlanVersionStatus(managedWedding.id, planId, "IN_REVIEW")).status).toBe(200);
      expect((await weddingData.setPlanVersionStatus(managedWedding.id, planId, "APPROVED")).status).toBe(200);
      await weddingData.createTable(managedWedding.id, { label: "Spare", capacity: 8 });
    });

    await test.step("An empty table removes in one click", async () => {
      await tablesTab.goto(managedWedding.id);
      await tablesTab.openTablesTab();
      await tablesTab.removeTable("Spare");
      await expect(tablesTab.removeTableButton("Spare")).toHaveCount(0);
      await expect(tablesTab.removalConfirmation()).toHaveCount(0);
      expect((await weddingData.listTables(managedWedding.id)).some((t) => t.label === "Spare")).toBe(false);
    });

    await test.step("A table with seated guests asks first, and 'Keep table' changes nothing", async () => {
      await tablesTab.removeTable("Table A");
      await expect(tablesTab.removalConfirmation()).toContainText('2 guests are seated at "Table A" in the current plan.');
      await expect(detailPage.saveStatus()).not.toContainText("Not saved");
      await tablesTab.keepTable();
      await expect(tablesTab.removalConfirmation()).toHaveCount(0);
      await expect(tablesTab.removeTableButton("Table A")).toBeVisible();

      const plan = await weddingData.getPlanVersionDetail(managedWedding.id, planId);
      expect(plan).toMatchObject({ isComplete: true, status: "APPROVED" });
      expect(plan.modifiedSinceApproval.active).toBe(false);
    });

    await test.step("'Remove anyway' removes it and leaves the plan honestly incomplete and flagged", async () => {
      await tablesTab.removeTable("Table A");
      await tablesTab.confirmTableRemoval();
      await expect(tablesTab.removeTableButton("Table A")).toHaveCount(0);
      await expect(detailPage.saveStatus()).not.toContainText("Not saved");

      const plan = await weddingData.getPlanVersionDetail(managedWedding.id, planId);
      expect(plan.isComplete).toBe(false);
      expect([...plan.unassignedGuestIds].sort()).toEqual(seatedAtA);
      expect(plan.modifiedSinceApproval.active).toBe(true);
      const activity = await weddingData.getActivity(managedWedding.id);
      expect(activity.map((e) => e.description)).toContain('Table "Table A" removed — 2 guests left unassigned');
    });

    await test.step("The API refuses an unconfirmed removal of a table with a seated guest", async () => {
      const res = await context.request.delete(`/api/v1/weddings/${managedWedding.id}/tables/${tableBId}`);
      expect(res.status()).toBe(409);
      expect(await res.json()).toMatchObject({ needsConfirmation: true, seatedCount: 1 });
      expect((await weddingData.listTables(managedWedding.id)).some((t) => t.id === tableBId)).toBe(true);
    });
  },
);
