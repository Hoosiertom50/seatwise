/**
 * TS-110 (REQ-TABLE-VENUE-LAYOUT) — a floor-plan drag whose save does not land must never leave
 * the table drawn somewhere the server doesn't have it.
 *
 * Before TS-110, `FloorPlan` kept a drag-time `localPositions` override that was never cleared, and
 * `onMove` never reverted its own optimistic update on failure. So a failed save showed an error
 * but left the table at the dropped spot, and a 409's "silent re-sync" to the other collaborator's
 * position was invisible because the stale override still won. Both halves are exercised here
 * through the real UI with real pointer events:
 *
 * - the server refuses the save (injected 500): the table snaps back to its last saved position
 *   and the error is shown;
 * - another collaborator moved the same table first (a real 409, from a genuinely stale revision):
 *   the table shows *their* position, not the dropped one.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { failRequests } from "../support/networkFaults.js";

interface TableRow {
  id: string;
  positionX: number | null;
  positionY: number | null;
}

defineQualityTest(
  {
    id: "tables.failed-floor-plan-move-snaps-back-to-the-saved-position.server-error-and-conflict",
    title: "a floor-plan table whose position save fails or conflicts is redrawn at the server's position, never left where it was dropped",
    objective:
      "Confirms that when dragging a table on the floor plan fails to save (server error), the table visibly returns to its last saved position with the error shown and nothing persisted; and that when the drag loses a real revision conflict to another collaborator's move, the table is redrawn at that collaborator's position.",
    expectedOutcome:
      "After the injected 500 the table's drawn position equals its original saved position, the error message is visible, and the server still holds the original position. After the conflicting move, the table's drawn position equals the other collaborator's saved position.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }) => {
    const ORIGINAL = { x: 60, y: 60 };
    const THEIRS = { x: 400, y: 260 };
    let tableId = "";
    let label = "";

    await test.step("Arrange: one table at a known saved position", async () => {
      const [table] = await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
      tableId = table.id;
      label = table.label;
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/tables/${tableId}`, {
        data: { positionX: ORIGINAL.x, positionY: ORIGINAL.y },
      });
      expect(res.ok()).toBe(true);
    });

    const tablesPage = new TablesTabPage(page);
    await test.step("Arrange: open the Tables tab's floor plan", async () => {
      await tablesPage.goto(managedWedding.id);
      await tablesPage.openTablesTab();
      await tablesPage.openFloorPlan();
      await expect(tablesPage.floorPlanTable(label)).toBeVisible();
      expect(await tablesPage.floorPlanTablePosition(label)).toEqual(ORIGINAL);
    });

    await test.step("Act + Assert: a drag whose save the server refuses snaps back and says so", async () => {
      const fault = await failRequests(page, `**/api/v1/weddings/${managedWedding.id}/tables/${tableId}`, "PATCH", {
        status: 500,
        error: "Simulated outage while saving the table position.",
      });
      await tablesPage.dragFloorPlanTable(label, 180, 120);
      await expect(tablesPage.message("Simulated outage while saving the table position.")).toBeVisible();
      expect(fault.hits).toBe(1);
      await expect.poll(() => tablesPage.floorPlanTablePosition(label)).toEqual(ORIGINAL);
      await fault.clear();

      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/tables`);
      const { tables } = (await res.json()) as { tables: TableRow[] };
      const saved = tables.find((t) => t.id === tableId)!;
      expect({ x: saved.positionX, y: saved.positionY }).toEqual(ORIGINAL);
    });

    await test.step("Act + Assert: a drag that loses a revision conflict shows the other collaborator's position", async () => {
      // Another collaborator's move lands first, bumping the revision this page last loaded.
      const theirs = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/tables/${tableId}`, {
        data: { positionX: THEIRS.x, positionY: THEIRS.y },
      });
      expect(theirs.ok()).toBe(true);

      await tablesPage.dragFloorPlanTable(label, 100, 40);
      await expect.poll(() => tablesPage.floorPlanTablePosition(label)).toEqual(THEIRS);
    });
  },
);
