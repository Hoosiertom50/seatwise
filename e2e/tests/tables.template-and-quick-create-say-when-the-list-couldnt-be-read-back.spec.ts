/**
 * TS-216 (REQ-REUSABLE-TEMPLATES, REQ-TABLE-VENUE-LAYOUT) — saves that went through but whose
 * result couldn't be read back afterwards (TS-209: the server answers success with `null` and a
 * warning).
 * - Save as template: the form cleared with no confirmation at all. Now it says the template was
 *   saved and to refresh to see it.
 * - Quick-create / Add tables from a template: the server's note wasn't shown, and the old table
 *   list stayed under "Added 2 tables". Now the note shows and the list is fetched again.
 *
 * The lost read-back is simulated with dropReadBack (the real save still happens).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueTitle } from "../data/ids.js";
import { dropReadBack } from "../support/networkFaults.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";

const NOT_REFRESHED = "Saved, but Seatwise couldn't load the latest just now — refresh the page to see it.";

defineQualityTest(
  {
    id: "tables.template-and-quick-create-say-when-the-list-couldnt-be-read-back.save-quick-create-apply",
    title: "save as template, quick-create and adding a template's tables say so when the result couldn't be read back, and the table list still shows the new tables",
    objective:
      "Confirms that when Save as template is saved but not read back, the tab says 'Saved “<name>” — refresh the page to see it.'; and that when quick-create or Add tables from a template is saved but its table list isn't returned, the tab shows the server's note and fetches the list again, so the new tables appear without a reload.",
    expectedOutcome:
      "The save-as-template confirmation names the template and says to refresh. After the quick-create, the note is shown and 'Table 1' and 'Table 2' are listed. After adding the template's tables, the note is shown, 'Added 2 tables from …' is shown, and the copies ('Table 1 (2)', 'Table 2 (2)') are listed.",
    requirementIds: ["REQ-REUSABLE-TEMPLATES", "REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@feature:templates", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const tablesTab = new TablesTabPage(page);
    await tablesTab.goto(w);
    await tablesTab.openTablesTab();

    await test.step("Quick-create: the note shows and the new tables are listed", async () => {
      const fault = await dropReadBack(page, /\/api\/v1\/weddings\/[^/]+\/tables\/quick-create$/, "POST", "tables");
      await tablesTab.quickCreateTables(2, 8);
      expect(fault.hits).toBe(1);
      await expect(tablesTab.warning(NOT_REFRESHED)).toBeVisible();
      await expect(tablesTab.removeTableButton("Table 1")).toBeVisible();
      await expect(tablesTab.removeTableButton("Table 2")).toBeVisible();
      await fault.clear();
    });

    const templateName = uniqueTitle(testInfo.workerIndex, "Read Back Layout");
    await test.step("Save as template: saved, and says to refresh to see it", async () => {
      const fault = await dropReadBack(page, /\/api\/v1\/weddings\/[^/]+\/save-as-template$/, "POST", "template");
      await tablesTab.saveAsTemplate(templateName);
      expect(fault.hits).toBe(1);
      await expect(tablesTab.templateSavedNotice(`Saved “${templateName}” — refresh the page to see it.`)).toBeVisible();
      await fault.clear();
      expect((await weddingData.listTemplates()).some((t) => t.name === templateName)).toBe(true);
    });

    await test.step("Add tables from a template: the note shows and the copies are listed", async () => {
      const fault = await dropReadBack(page, /\/api\/v1\/weddings\/[^/]+\/apply-template$/, "POST", "tables");
      await tablesTab.addTablesFromTemplate(templateName);
      expect(fault.hits).toBe(1);
      await expect(tablesTab.warning(NOT_REFRESHED)).toBeVisible();
      await expect(tablesTab.removeTableButton("Table 1 (2)")).toBeVisible();
      await expect(tablesTab.removeTableButton("Table 2 (2)")).toBeVisible();
      await fault.clear();
    });
  },
);
