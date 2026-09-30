/**
 * TS-126 (REQ-PLAN-REVIEW-STATUS, REQ-TABLE-VENUE-LAYOUT) — found in Tom's manual test: the
 * Seating plan tab's List view built its tables from the plan's seat assignments, so a table
 * nobody sat at wasn't listed at all ("21 tables, but only 19 showing"), and no table showed how
 * many seats were free. Now every table is listed, each with "x/N seated" -- or "Empty — N seats
 * free" -- so a planner can see where there's room before seating unassigned guests.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "plan-review.list-view-shows-every-table-with-its-free-seats.empty-and-partial-tables",
    title: "the Seating plan List view lists every table -- including empty ones -- with how many of its seats are taken",
    objective:
      "Confirms that after generating a plan, the List view shows a table that nobody is seated at as 'Empty — N seats free', a partly filled table as 'x/N seated', and lists every table in the wedding, not only those with guests.",
    expectedOutcome:
      "With three guests at an 8-seat 'Main' table and an empty 4-seat 'Spare' table, the List view shows 'Main' with '3/8 seated' and 'Spare' with 'Empty — 4 seats free'.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS", "REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const planTab = new PlanTabPage(page);

    await test.step("Arrange: three guests seated at 'Main', then an empty 'Spare' table added", async () => {
      for (let i = 0; i < 3; i++) await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.createTable(managedWedding.id, { label: "Main", capacity: 8 });
      const plan = await weddingData.generatePlanVersion(managedWedding.id);
      expect(plan.isComplete).toBe(true);
      await weddingData.createTable(managedWedding.id, { label: "Spare", capacity: 4 });
    });

    await test.step("Assert: both tables are listed, each with its seat summary", async () => {
      await planTab.goto(managedWedding.id);
      await expect(planTab.listTableSeatSummary("Main")).toHaveText("3/8 seated");
      await expect(planTab.listTableSeatSummary("Spare")).toHaveText("Empty — 4 seats free");
    });
  },
);
