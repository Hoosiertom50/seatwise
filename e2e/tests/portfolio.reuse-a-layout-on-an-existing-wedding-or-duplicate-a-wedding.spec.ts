/**
 * TS-91 (REQ-REUSABLE-TEMPLATES, REQ-PLANNER-PORTFOLIO) — a planner can reuse a room layout without
 * rebuilding it: (a) add a saved template's tables to a wedding that already exists (before TS-91
 * a template could only be picked when creating a wedding), and (b) duplicate a wedding they own
 * into a new wedding carrying its layout and seating settings but none of its guests.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";

interface TableRow {
  id: string;
  label: string;
  capacity: number;
  shape: string;
  positionX: number | null;
  positionY: number | null;
}

defineQualityTest(
  {
    id: "portfolio.reuse-a-layout-on-an-existing-wedding-or-duplicate-a-wedding.apply-template-and-duplicate",
    title: "a saved template's tables can be added to an existing wedding without touching its tables, and a wedding can be duplicated with its layout but none of its guests",
    objective:
      "Confirms adding a template to an existing wedding appends its tables with shapes and positions intact, renames a clashing label instead of duplicating it, and leaves existing tables unchanged; and that duplicating a wedding from the dashboard opens a new wedding with the same tables, positions, shapes and side-mixing, and no guests.",
    expectedOutcome:
      "After applying, the wedding has its original table unchanged plus the template's tables, one relabelled 'Table 1 (2)'. After duplicating, the browser is on the new wedding, named '<source> (copy)', whose tables match the source's labels, shapes and positions, with 0 guests.",
    requirementIds: ["REQ-REUSABLE-TEMPLATES", "REQ-PLANNER-PORTFOLIO"],
    tags: ["@mutating", "@feature:templates", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    const tablesOf = async (weddingId: string) =>
      ((await (await context.request.get(`/api/v1/weddings/${weddingId}/tables`)).json()) as { tables: TableRow[] }).tables;

    // A source wedding with a distinctive, positioned layout -- and a guest, who must never be copied.
    let source = { id: "", name: "" };
    let templateName = "";
    await test.step("Arrange: a source wedding with two shaped, positioned tables and a guest, saved as a template", async () => {
      source = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Layout Source"));
      const [t1, t2] = await weddingData.quickCreateTables(source.id, { count: 2, capacity: 10 });
      await context.request.patch(`/api/v1/weddings/${source.id}/tables/${t1.id}`, { data: { shape: "RECTANGULAR", positionX: 120, positionY: 80 } });
      await context.request.patch(`/api/v1/weddings/${source.id}/tables/${t2.id}`, { data: { shape: "OVAL", positionX: 420, positionY: 260 } });
      await weddingData.createGuest(source.id, uniquePersonName(testInfo.workerIndex));
      templateName = uniqueTitle(testInfo.workerIndex, "Venue Layout");
      await weddingData.saveWeddingAsTemplate(source.id, templateName);
    });

    await test.step("Act + Assert: adding the template to an existing wedding appends its tables and leaves the existing one alone", async () => {
      const [existing] = await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 6 });
      const tablesPage = new TablesTabPage(page);
      await tablesPage.goto(managedWedding.id);
      await tablesPage.openTablesTab();
      await tablesPage.addTablesFromTemplate(templateName);

      const after = await tablesOf(managedWedding.id);
      expect(after).toHaveLength(3);
      const kept = after.find((t) => t.id === existing.id)!;
      expect(kept.label).toBe(existing.label);
      expect(kept.capacity).toBe(6);
      expect(after.map((t) => t.label).sort()).toEqual(["Table 1", "Table 1 (2)", "Table 2"]);
      const copied = after.find((t) => t.label === "Table 2")!;
      expect({ shape: copied.shape, x: copied.positionX, y: copied.positionY }).toEqual({ shape: "OVAL", x: 420, y: 260 });
    });

    await test.step("Act + Assert: duplicating from the dashboard opens a new wedding with the layout and no guests", async () => {
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      await Promise.all([
        page.waitForURL((url) => /^\/weddings\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(source.id)),
        dashboard.duplicateLayoutButton(source.name).click(),
      ]);
      const copyId = new URL(page.url()).pathname.split("/").pop()!;
      weddingData.trackWedding(copyId);

      const wedding = ((await (await context.request.get(`/api/v1/weddings/${copyId}`)).json()) as { wedding: { name: string } }).wedding;
      expect(wedding.name).toBe(`${source.name} (copy)`);
      const shape = (ts: TableRow[]) =>
        ts.map((t) => ({ label: t.label, shape: t.shape, x: t.positionX, y: t.positionY, capacity: t.capacity })).sort((a, b) => a.label.localeCompare(b.label));
      expect(shape(await tablesOf(copyId))).toEqual(shape(await tablesOf(source.id)));
      const guests = ((await (await context.request.get(`/api/v1/weddings/${copyId}/guests`)).json()) as { guests: unknown[] }).guests;
      expect(guests).toHaveLength(0);
    });
  },
);
