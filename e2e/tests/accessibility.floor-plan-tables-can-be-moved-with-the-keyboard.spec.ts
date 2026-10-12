/**
 * TS-121 (REQ-TABLE-VENUE-LAYOUT, REQ-NON-FUNCTIONAL) — the Tables tab's floor plan could only be
 * arranged by dragging, so a keyboard-only planner couldn't set up the room. Now each table can be
 * reached with Tab and moved with the arrow keys (10px a press, 50px with Shift), staying inside
 * the floor plan. A run of presses is saved once the planner pauses -- through the same revision
 * check as a drag, so a move that loses to someone else's says so (TS-92) -- and a screen reader
 * hears each new position. View-level collaborators get no movable tables.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { scanForWcagAaViolations } from "../support/axeScan.js";

defineQualityTest(
  {
    id: "accessibility.floor-plan-tables-can-be-moved-with-the-keyboard.move-save-clamp-conflict-view-only",
    title: "a floor-plan table can be reached with Tab and moved with the arrow keys -- saved, announced, kept in bounds, refused with a message on a conflict -- while View users get nothing to move",
    objective:
      "Confirms that a keyboard-only planner can Tab to a table on the floor plan, move it with arrow keys (10px, or 50px with Shift) with each position announced, that the move is saved and survives a reload, that it can't leave the floor plan, that a keyboard move losing to someone else's shows the conflict message and the other position, that the floor plan has no WCAG 2.1 AA violations, and that a View collaborator's floor plan offers no movable tables.",
    expectedOutcome:
      "From (60, 60): three Right and two Down presses land at (90, 80), then Shift+Right at (140, 80); the announcement reads 'Table 1 moved to 140, 80.'; the API and a reload both show (140, 80). Holding Shift+Left stops at x 0. After another collaborator moves it to (400, 260), a keyboard move shows 'was moved since you loaded it' and the table sits at (400, 260). The axe scan finds 0 violations. The View collaborator sees no movable-table buttons.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context, browser }, testInfo) => {
    const tablesTab = new TablesTabPage(page);
    const w = managedWedding.id;
    const [table] = await weddingData.quickCreateTables(w, { count: 1, capacity: 8 });
    await context.request.patch(`/api/v1/weddings/${w}/tables/${table.id}`, { data: { positionX: 60, positionY: 60 } });
    const saved = async () => {
      const t = (await weddingData.listTables(w)).find((x) => x.id === table.id) as unknown as { positionX: number; positionY: number };
      return { x: t.positionX, y: t.positionY };
    };
    const openFloorPlan = async () => {
      await tablesTab.goto(w);
      await tablesTab.openTablesTab();
      await tablesTab.openFloorPlan();
      await expect(tablesTab.floorPlanTable(table.label)).toBeVisible();
    };

    await test.step("Tab to the table and move it with the arrow keys; each move is announced and saved", async () => {
      await openFloorPlan();
      await tablesTab.tabToFloorPlanTable(table.label);
      await tablesTab.pressOnFocusedTable("ArrowRight", 3);
      await tablesTab.pressOnFocusedTable("ArrowDown", 2);
      await expect.poll(() => tablesTab.floorPlanTablePosition(table.label)).toEqual({ x: 90, y: 80 });
      await tablesTab.pressOnFocusedTable("Shift+ArrowRight");
      await expect(tablesTab.moveAnnouncement()).toHaveText(`${table.label} moved to 140, 80.`);
      await expect.poll(saved, { timeout: 5_000 }).toEqual({ x: 140, y: 80 });
    });

    await test.step("The move survives a reload", async () => {
      await openFloorPlan();
      expect(await tablesTab.floorPlanTablePosition(table.label)).toEqual({ x: 140, y: 80 });
    });

    await test.step("It can't be moved off the floor plan", async () => {
      await tablesTab.tabToFloorPlanTable(table.label);
      await tablesTab.pressOnFocusedTable("Shift+ArrowLeft", 6);
      await expect.poll(() => tablesTab.floorPlanTablePosition(table.label)).toEqual({ x: 0, y: 80 });
      await expect.poll(saved, { timeout: 5_000 }).toEqual({ x: 0, y: 80 });
    });

    await test.step("A keyboard move that loses to someone else's says so and shows theirs", async () => {
      await context.request.patch(`/api/v1/weddings/${w}/tables/${table.id}`, { data: { positionX: 400, positionY: 260 } });
      await tablesTab.pressOnFocusedTable("ArrowRight");
      await expect(tablesTab.message(/^"[^"]+" was moved since you loaded it \(maybe in another tab, or by someone else\)/)).toBeVisible();
      await expect.poll(() => tablesTab.floorPlanTablePosition(table.label)).toEqual({ x: 400, y: 260 });
      expect(await saved()).toEqual({ x: 400, y: 260 });
    });

    await test.step("The floor plan has no WCAG 2.1 AA violations", async () => {
      const result = await scanForWcagAaViolations(page);
      expect(result.violationCount, result.summary).toBe(0);
    });

    await test.step("A View collaborator gets nothing to move", async () => {
      const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
      try {
        await weddingData.addCollaborator(w, viewer.email, "VIEW");
        const viewerTab = new TablesTabPage(await viewer.context.newPage());
        await viewerTab.goto(w);
        await viewerTab.openTablesTab();
        await viewerTab.openFloorPlan();
        await expect(viewerTab.floorPlanTable(table.label)).toBeVisible();
        await expect(viewerTab.movableFloorPlanTable(table.label)).toHaveCount(0);
      } finally {
        await viewer.context.close();
      }
    });
  },
);
