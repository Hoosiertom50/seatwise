/**
 * TS-38 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — converts the guest-locking half of AC-044 ("Locking
 * preserves placements and avoids needless reshuffling"). The workbook's own AC-044 precondition
 * also covers a locked *table* retaining exactly its prior membership; that half isn't automated
 * here (it needs its own TablesTab lock control and a distinct set of assertions) -- this test
 * covers the guest-lock half specifically: a locked guest's own table assignment survives a
 * regeneration that adds new guests and a new table, which is exactly the scenario where an
 * unlocked guest *could* have been reshuffled.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { uniquePersonName } from "../data/ids.js";

interface AssignmentEntry {
  guestName: string;
  tableId: string;
}

async function getCurrentAssignments(
  request: { get(url: string): Promise<{ ok(): boolean; json(): Promise<unknown> }> },
  weddingId: string,
): Promise<AssignmentEntry[]> {
  const listRes = await request.get(`/api/v1/weddings/${weddingId}/plan-versions`);
  if (!listRes.ok()) throw new Error("Failed to list plan versions");
  const { planVersions } = (await listRes.json()) as { planVersions: { id: string; isCurrent: boolean }[] };
  const current = planVersions.find((v) => v.isCurrent);
  if (!current) throw new Error("No Current plan version exists");
  const detailRes = await request.get(`/api/v1/weddings/${weddingId}/plan-versions/${current.id}`);
  if (!detailRes.ok()) throw new Error("Failed to load the Current plan version's detail");
  const { planVersion } = (await detailRes.json()) as { planVersion: { assignments: AssignmentEntry[] } };
  return planVersion.assignments;
}

defineQualityTest(
  {
    id: "seat-assignment.locked-guest-placement-preserved-on-regenerate.guest-lock",
    title: "a locked guest keeps their table when the plan is regenerated with new guests and tables",
    objective:
      "Confirms that locking a guest through the Guests tab, then regenerating after adding new guests and a new table, leaves that guest at their original table while the rest of the plan is freely recomputed.",
    expectedOutcome:
      "The locked guest's table id is identical before and after the second generation, and the plan remains complete (every guest seated) after it.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, page, context, evidence }, testInfo) => {
    const planTabPage = new PlanTabPage(page);
    const guestNames = [
      uniquePersonName(testInfo.workerIndex),
      uniquePersonName(testInfo.workerIndex),
      uniquePersonName(testInfo.workerIndex),
      uniquePersonName(testInfo.workerIndex),
    ];
    const lockedGuest = guestNames[0];
    const lockedGuestFullName = `${lockedGuest.firstName} ${lockedGuest.lastName}`;

    await test.step("Arrange: 4 guests and exactly 2 tables of capacity 2 (no free choice in how many are seated, only which table each lands on)", async () => {
      for (const name of guestNames) {
        await weddingData.createGuest(managedWedding.id, name);
      }
      await weddingData.quickCreateTables(managedWedding.id, { count: 2, capacity: 2 });
    });

    await test.step("Act: generate the first plan", async () => {
      await planTabPage.goto(managedWedding.id);
      await planTabPage.generate();
    });

    const originalTableId = await test.step("Record which table the guest to be locked landed on", async () => {
      const assignments = await getCurrentAssignments(context.request, managedWedding.id);
      const entry = assignments.find((a) => a.guestName === lockedGuestFullName);
      expect(entry).toBeDefined();
      return entry!.tableId;
    });

    await test.step("Act: lock that guest through the Guests tab", async () => {
      await weddingGuestsPage.goto(managedWedding.id);
      await weddingGuestsPage.openGuestsTab();
      const row = weddingGuestsPage.guestRow(lockedGuestFullName);
      await row.toggleLock();
      expect(await row.isLocked()).toBe(true);
    });

    await test.step("Act: add two more guests and a third table, then regenerate", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 2 });
      await planTabPage.goto(managedWedding.id);
      await planTabPage.generate();
    });

    await test.step("Assert: the locked guest is still at their original table, and the plan is complete", async () => {
      await expect(planTabPage.textLocator("0 unassigned")).toBeVisible();
      const assignments = await getCurrentAssignments(context.request, managedWedding.id);
      const entry = assignments.find((a) => a.guestName === lockedGuestFullName);
      expect(entry).toBeDefined();
      expect(entry!.tableId).toBe(originalTableId);
    });

    await evidence.checkpoint(
      "locked-guest-unmoved",
      `${lockedGuestFullName} stayed at table ${originalTableId} across a regeneration that added two guests and a new table.`,
    );
  },
);
