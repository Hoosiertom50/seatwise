/**
 * TS-92 (REQ-COLLABORATION-NOTIFICATIONS, REQ-NON-FUNCTIONAL) — Tom's requirement, 2026-09-29: in
 * any scenario where a second person saves, nobody may walk away believing a change saved when the
 * back end didn't keep it, and a save may never silently overwrite someone else's change.
 *
 * Guests, tables, vendors and plan moves already refused stale saves (FR-7.7) and have their own
 * specs. This covers every shared edit path TS-92's audit found unprotected, each driven through
 * the real UI with "the other collaborator" played by a direct API call landing first:
 *
 * - editing a timeline entry (no revision existed at all);
 * - changing the budget figure (no revision existed at all);
 * - a CSV import confirmed after someone else edited one of its guests (the import used to
 *   overwrite them), plus the import itself bumping revision so a stale planner save made
 *   afterwards is refused;
 * - a floor-plan table drag that loses to someone else's move (it used to re-sync silently).
 *
 * Deliberately not covered: wedding details and collaborator permissions (owner-only -- there is
 * no second person), and day-of attendance (a set-to-what-you-see toggle that can't overwrite a
 * different change -- see TS-92's Jira notes).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { uniquePersonName } from "../data/ids.js";

interface GuestRow {
  id: string;
  firstName: string;
  lastName: string;
  revision: number;
}

defineQualityTest(
  {
    id: "collaboration.a-stale-save-is-refused-with-a-message-never-silently-lost.timeline-budget-import-floor-plan",
    title: "a save based on stale data is refused with a visible message and the latest shown — timeline edit, budget figure, CSV import, and floor-plan move — never silently lost or overwriting",
    objective:
      "Confirms that when another collaborator's change lands first, a planner's stale timeline edit, budget change, CSV import, and table drag are each refused with a message saying so, the other person's value is what's shown and what's stored, and an import bumps guest revisions so a later stale guest edit is refused too.",
    expectedOutcome:
      "Each stale save shows a 'someone else changed…' message; the screen shows the other collaborator's value; the server still holds that value (the stale save wrote nothing); the refused import creates and changes nothing; a guest PATCH with a pre-import revision returns 409.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, page }, testInfo) => {
    const base = `/api/v1/weddings/${managedWedding.id}`;

    await test.step("Timeline: a stale edit is refused, and the other person's text is what's shown and stored", async () => {
      const created = await weddingData.createTimelineEntry(managedWedding.id, { time: "17:00", description: "Cocktail hour" });
      const entryId = created.body.entry!.id;
      const timeline = new TimelineTabPage(page);
      await timeline.goto(managedWedding.id);
      await timeline.startEdit("Cocktail hour");

      const theirs = await weddingData.updateTimelineEntry(managedWedding.id, entryId, { description: "Cocktail hour on the terrace" });
      expect(theirs.status).toBe(200);

      await timeline.saveEdit("17:00", "Cocktail hour in the ballroom");
      await expect(timeline.errorText()).toContainText("Someone else changed this timeline entry");
      await expect(timeline.entryTimeText("Cocktail hour on the terrace")).toBeVisible();
      const [stored] = await weddingData.getTimelineEntries(managedWedding.id);
      expect(stored.description).toBe("Cocktail hour on the terrace");
    });

    await test.step("Budget: a stale figure is refused, and the box shows the figure actually on record", async () => {
      const budget = new BudgetTabPage(page);
      await budget.goto(managedWedding.id);

      const current = (await (await context.request.get(`${base}/budget`)).json()) as { summary: { budgetRevision: number } };
      const theirs = await context.request.patch(`${base}/budget`, {
        data: { budgetCents: 2_500_000, expectedRevision: current.summary.budgetRevision },
      });
      expect(theirs.ok()).toBe(true);

      await budget.saveBudget("18000");
      await expect(budget.errorText()).toContainText("Someone else changed the budget figure");
      expect(await budget.budgetInputValue()).toBe("25000.00");
      const stored = (await (await context.request.get(`${base}/budget`)).json()) as { summary: { budgetCents: number } };
      expect(stored.summary.budgetCents).toBe(2_500_000);
    });

    let guestId = "";
    let lastName = "";
    await test.step("Import: confirming after someone else edited a guest in the file is refused, and nothing is written", async () => {
      const name = uniquePersonName(testInfo.workerIndex);
      lastName = name.lastName;
      guestId = (await weddingData.createGuest(managedWedding.id, name)).id;
      await weddingGuestsPage.goto(managedWedding.id);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.importGuestsFromCsvAndPreview(
        `guestId,firstName,lastName\n${guestId},Imported,${lastName}\n,Brand,New${lastName}\n`,
      );

      const theirs = await context.request.patch(`${base}/guests/${guestId}`, { data: { firstName: "Theirs" } });
      expect(theirs.ok()).toBe(true);

      await weddingGuestsPage.confirmImportExpectingRefusal();
      await expect(weddingGuestsPage.message(/^Nothing was imported: someone else changed a guest/)).toBeVisible();
      const { guests } = (await (await context.request.get(`${base}/guests`)).json()) as { guests: GuestRow[] };
      expect(guests.find((g) => g.id === guestId)!.firstName).toBe("Theirs");
      expect(guests.some((g) => g.lastName === `New${lastName}`)).toBe(false);
    });

    await test.step("Import: a completed import bumps revision, so a save based on the pre-import guest is refused", async () => {
      const before = (await (await context.request.get(`${base}/guests`)).json()) as { guests: GuestRow[] };
      const staleRevision = before.guests.find((g) => g.id === guestId)!.revision;
      const commit = await context.request.post(`${base}/guests/import/commit`, {
        data: {
          csv: `guestId,firstName,lastName\n${guestId},Imported,${lastName}\n`,
          mapping: { guestId: "guestId", firstName: "firstName", lastName: "lastName" },
          expectedRevisions: { [guestId]: staleRevision },
        },
      });
      expect(commit.ok()).toBe(true);

      const stale = await context.request.patch(`${base}/guests/${guestId}`, {
        data: { firstName: "Overwrite", expectedRevision: staleRevision },
      });
      expect(stale.status()).toBe(409);
      const { guests } = (await (await context.request.get(`${base}/guests`)).json()) as { guests: GuestRow[] };
      expect(guests.find((g) => g.id === guestId)!.firstName).toBe("Imported");
    });

    await test.step("Floor plan: a table drag that loses to someone else's move says so, instead of silently jumping", async () => {
      const [table] = await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
      await context.request.patch(`${base}/tables/${table.id}`, { data: { positionX: 60, positionY: 60 } });
      const tables = new TablesTabPage(page);
      await tables.goto(managedWedding.id);
      await tables.openTablesTab();
      await tables.openFloorPlan();
      await expect(tables.floorPlanTable(table.label)).toBeVisible();

      await context.request.patch(`${base}/tables/${table.id}`, { data: { positionX: 400, positionY: 260 } });
      await tables.dragFloorPlanTable(table.label, 100, 40);
      await expect(tables.message(/^"[^"]+" was moved by someone else just before you/)).toBeVisible();
      await expect.poll(() => tables.floorPlanTablePosition(table.label)).toEqual({ x: 400, y: 260 });
    });
  },
);
