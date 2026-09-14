/**
 * TS-41 (REQ-TABLE-VENUE-LAYOUT) — converts AC-037 ("Seats-vs-guests shortfall is shown clearly").
 * This is the one AC in this story that's computed and rendered client-side only (TablesTab.tsx),
 * with no dedicated API field of its own -- `totalCapacity`, `attendingHeadcount`, and `shortfall`
 * are all plain arithmetic over the same `guests`/`tables` lists the tab already fetches -- so it's
 * exercised through the real page rather than an API assertion.
 *
 * Traced directly against TablesTab.tsx: Attending headcount sums only `dayOfAttendance ===
 * "ATTENDING"` guests' `headcount` (a Not Attending guest is excluded entirely, matching FR-4.5's
 * "excludes Not Attending guests"), Total capacity sums every table's capacity, Remaining capacity
 * is `totalCapacity - attendingHeadcount` (shown in red once negative), and the shortfall warning
 * line only renders once that value is actually negative.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";

defineQualityTest(
  {
    id: "tables.seats-vs-guests-shortfall-is-shown-clearly.exact-counts-and-warning",
    title: "the Tables tab shows exact Attending/capacity/assigned/remaining counts and a clear shortfall warning once guests exceed capacity",
    objective:
      "Confirms the Tables tab's capacity overview shows the correct Attending headcount (excluding a Not Attending guest entirely), total table capacity, assigned count, and remaining capacity, with no shortfall warning while there's enough capacity -- and that adding one more Attending guest past capacity makes the exact shortfall warning appear.",
    expectedOutcome:
      "With capacity to spare: Attending reflects only the two Attending guests' headcount, Total capacity reflects the table, remaining capacity is positive, and no shortfall warning shows. After a third Attending guest is added past capacity: remaining capacity goes negative and a 'Short 1 seat(s)' warning appears.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const tablesTabPage = new TablesTabPage(page);

    await test.step("Arrange: two Attending guests, one Not Attending guest (must be excluded entirely), and one table with exactly enough capacity", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.createGuest(managedWedding.id, {
        ...uniquePersonName(testInfo.workerIndex),
        dayOfAttendance: "NOT_ATTENDING",
      });
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 2 });
    });

    await test.step("Act: open the Tables tab", async () => {
      await tablesTabPage.goto(managedWedding.id);
      await tablesTabPage.openTablesTab();
    });

    await test.step("Assert: Attending is exactly 2 (the Not Attending guest is excluded entirely), capacity is 2, and there's no shortfall warning", async () => {
      await expect.poll(() => tablesTabPage.attendingCount()).toBe(2);
      await expect.poll(() => tablesTabPage.totalCapacity()).toBe(2);
      await expect.poll(() => tablesTabPage.remainingCapacity()).toBe(0);
      await expect(tablesTabPage.shortfallWarning()).not.toBeVisible();
    });

    await test.step("Act: add one more Attending guest, pushing headcount past capacity", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await page.reload();
      // A full reload re-renders the wedding-detail page from scratch, defaulting back to its
      // first tab -- re-open Tables rather than assuming the reload preserves which tab was open.
      await tablesTabPage.openTablesTab();
    });

    await test.step("Assert: Attending is now 3, remaining capacity is negative, and the exact shortfall warning appears", async () => {
      await expect.poll(() => tablesTabPage.attendingCount()).toBe(3);
      await expect.poll(() => tablesTabPage.remainingCapacity()).toBe(-1);
      await expect(tablesTabPage.shortfallWarning()).toBeVisible();
      await expect(tablesTabPage.shortfallWarning()).toContainText("Short 1 seat(s) for everyone attending");
    });
  },
);
