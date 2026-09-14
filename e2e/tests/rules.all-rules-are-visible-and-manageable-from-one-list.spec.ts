/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-029 ("All rules are visible and
 * manageable from one dedicated list"). The tab is labeled "Seating rules" in the UI, not "Rules"
 * (see the `TABS` array in apps/web/src/app/weddings/[weddingId]/page.tsx).
 *
 * The AC's literal wording says a rule "can be edited or removed from that screen" -- read
 * directly against RulesTab.tsx's own comment ("Seating rules have no 'edit' verb (only
 * add/remove)") and the route tree (no PATCH/PUT exists for a relationship, only POST/DELETE):
 * editing a rule in place is not implemented at all, only creating a new one and removing an
 * existing one. This test proves the part that *is* implemented -- every rule type is listed with
 * its participants and can be removed from the one screen -- and doesn't assert a nonexistent
 * edit affordance.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { RulesTabPage } from "../pages/RulesTabPage.js";

defineQualityTest(
  {
    id: "rules.all-rules-are-visible-and-manageable-from-one-list.every-type-listed-and-removable",
    title: "every rule type is listed with its participants on the Seating rules tab, and can be removed from there",
    objective:
      "Confirms that a rule of each of the four supported types, between different guest pairs, all appear together on the Seating rules tab naming both participants and the rule's type -- and that removing one from that screen takes it out of the list without disturbing the others.",
    expectedOutcome:
      "The Rules (4) heading and all four rule rows are visible, each naming the correct guest pair and type label. After removing one rule, the heading reads Rules (3) and only that row is gone.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const rulesTabPage = new RulesTabPage(page);
    const nameA = uniquePersonName(testInfo.workerIndex);
    const nameB = uniquePersonName(testInfo.workerIndex);
    const nameC = uniquePersonName(testInfo.workerIndex);
    const nameD = uniquePersonName(testInfo.workerIndex);
    const nameE = uniquePersonName(testInfo.workerIndex);
    const nameF = uniquePersonName(testInfo.workerIndex);
    const nameG = uniquePersonName(testInfo.workerIndex);
    const nameH = uniquePersonName(testInfo.workerIndex);
    const fullName = (n: { firstName: string; lastName: string }) => `${n.firstName} ${n.lastName}`;

    await test.step("Arrange: one rule of each type, across different guest pairs", async () => {
      const a = await weddingData.createGuest(managedWedding.id, nameA);
      const b = await weddingData.createGuest(managedWedding.id, nameB);
      const c = await weddingData.createGuest(managedWedding.id, nameC);
      const d = await weddingData.createGuest(managedWedding.id, nameD);
      const e = await weddingData.createGuest(managedWedding.id, nameE);
      const f = await weddingData.createGuest(managedWedding.id, nameF);
      const g = await weddingData.createGuest(managedWedding.id, nameG);
      const h = await weddingData.createGuest(managedWedding.id, nameH);
      await weddingData.createRelationship(managedWedding.id, a.id, b.id, "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, c.id, d.id, "MUST_NOT_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, e.id, f.id, "PREFER_NEAR");
      await weddingData.createRelationship(managedWedding.id, g.id, h.id, "AVOID");
    });

    await test.step("Act: open the Seating rules tab", async () => {
      await rulesTabPage.goto(managedWedding.id);
      await rulesTabPage.openRulesTab();
    });

    await test.step("Assert: all four rules are listed, each naming the right pair and type", async () => {
      await expect(rulesTabPage.rulesHeading(4)).toBeVisible();
      await expect(rulesTabPage.ruleRow(fullName(nameA), fullName(nameB)).locator()).toContainText("Must sit together");
      await expect(rulesTabPage.ruleRow(fullName(nameC), fullName(nameD)).locator()).toContainText("Must NOT sit together");
      await expect(rulesTabPage.ruleRow(fullName(nameE), fullName(nameF)).locator()).toContainText("Prefer near (soft)");
      await expect(rulesTabPage.ruleRow(fullName(nameG), fullName(nameH)).locator()).toContainText("Avoid (soft)");
    });

    await test.step("Act: remove the Prefer-Near rule from the list", async () => {
      await rulesTabPage.ruleRow(fullName(nameE), fullName(nameF)).remove();
    });

    await test.step("Assert: the list now shows 3 rules, the removed one is gone, and the other three are untouched", async () => {
      await expect(rulesTabPage.rulesHeading(3)).toBeVisible();
      await expect(rulesTabPage.ruleRow(fullName(nameE), fullName(nameF)).locator()).not.toBeVisible();
      await expect(rulesTabPage.ruleRow(fullName(nameA), fullName(nameB)).locator()).toBeVisible();
      await expect(rulesTabPage.ruleRow(fullName(nameC), fullName(nameD)).locator()).toBeVisible();
      await expect(rulesTabPage.ruleRow(fullName(nameG), fullName(nameH)).locator()).toBeVisible();
    });
  },
);
