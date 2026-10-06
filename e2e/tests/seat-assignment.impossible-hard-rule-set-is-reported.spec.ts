/**
 * TS-38 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — converts AC-041 ("An impossible hard-rule set is
 * reported, never silently forced"). The impossible set here is a transitive one across three
 * guests: A-B and B-C both MUST_SIT_TOGETHER (forcing all three into one group), then A-C
 * MUST_NOT_SIT_TOGETHER.
 *
 * TS-181: that contradiction is now caught when the third rule is added -- the relationships API
 * refuses it (409) with a message naming the guests and the chain of rules that links them, so it
 * never reaches Generate. (Before, adding it was allowed and every Generate then failed with "These
 * rule conflicts need to be fixed first".) The engine's own contradiction check is still there for
 * data saved before TS-181, but can no longer be reached through the app.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { RulesTabPage } from "../pages/RulesTabPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "seat-assignment.impossible-hard-rule-set-is-reported.transitive-contradiction",
    title: "a transitively-impossible hard-rule set is refused when it's created, not silently forced",
    objective:
      "Confirms that when must-sit-together rules force three guests into one group, adding a must-not-sit-together rule between two of them from the Seating rules tab is refused with a message naming the guests and the chain, the rule isn't saved, and Generate still produces a complete plan with all three at one table.",
    expectedOutcome:
      "The Seating rules tab shows an error naming A, B and C and saying the rules would always seat A and C at the same table; the list still has 2 rules; a generated plan seats all three together and is complete.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT", "REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:relationships", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, evidence }, testInfo) => {
    const rulesTabPage = new RulesTabPage(page);
    const planTabPage = new PlanTabPage(page);
    const guestA = uniquePersonName(testInfo.workerIndex);
    const guestB = uniquePersonName(testInfo.workerIndex);
    const guestC = uniquePersonName(testInfo.workerIndex);
    const fullName = (g: { firstName: string; lastName: string }) => `${g.firstName} ${g.lastName}`;
    const ids: string[] = [];

    await test.step("Arrange: A-B and B-C must sit together, forcing all three into one group", async () => {
      for (const g of [guestA, guestB, guestC]) ids.push((await weddingData.createGuest(managedWedding.id, g)).id);
      await weddingData.createRelationship(managedWedding.id, ids[0], ids[1], "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, ids[1], ids[2], "MUST_SIT_TOGETHER");
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
    });

    await test.step("Act: add 'A and C must not sit together' from the Seating rules tab", async () => {
      await rulesTabPage.goto(managedWedding.id);
      await rulesTabPage.openRulesTab();
      await expect(rulesTabPage.rulesHeading(2)).toBeVisible();
      await rulesTabPage.addRule(fullName(guestA), fullName(guestC), "MUST_NOT_SIT_TOGETHER");
    });

    await test.step("Assert: the rule is refused, naming the guests and the chain, and isn't saved", async () => {
      const alert = rulesTabPage.errorAlert();
      await expect(alert).toContainText("would always seat them at the same table");
      for (const g of [guestA, guestB, guestC]) await expect(alert).toContainText(fullName(g));
      await expect(rulesTabPage.rulesHeading(2)).toBeVisible();
      expect(await weddingData.listRelationships(managedWedding.id)).toHaveLength(2);
    });

    await test.step("Assert: Generate still works -- all three at one table, complete", async () => {
      await planTabPage.goto(managedWedding.id);
      await planTabPage.generate();
      await expect.poll(async () => (await weddingData.listPlanVersions(managedWedding.id)).length).toBe(1);
      const current = (await weddingData.listPlanVersions(managedWedding.id)).find((v) => v.isCurrent)!;
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, current.id);
      expect(new Set(detail.assignments.map((a) => a.tableId)).size).toBe(1);
      expect(detail.assignments.map((a) => a.guestId).sort()).toEqual([...ids].sort());
      expect(detail.isComplete).toBe(true);
    });

    await evidence.checkpoint(
      "impossible-rule-set-refused",
      `Adding "${fullName(guestA)} and ${fullName(guestC)} must not sit together" was refused naming the chain through ${fullName(guestB)}; the generated plan seats all three together.`,
    );
  },
);
