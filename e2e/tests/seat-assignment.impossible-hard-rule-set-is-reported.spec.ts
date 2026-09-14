/**
 * TS-38 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — converts AC-041 ("An impossible hard-rule set is
 * reported, never silently forced"). The app's relationships API already refuses to create a
 * direct MUST_SIT_TOGETHER/MUST_NOT_SIT_TOGETHER pair between the same two guests (a 409
 * "RelationshipConflictError" at creation time -- see packages/db/src/queries/relationships.ts),
 * so this test builds the contradiction the generation engine itself has to catch: a transitive
 * one across three guests (A-B and B-C both MUST_SIT_TOGETHER, forcing all three into one unit,
 * while A-C is separately MUST_NOT_SIT_TOGETHER -- a pair that had no direct relationship yet, so
 * creating it is allowed even though the resulting generation is impossible).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "seat-assignment.impossible-hard-rule-set-is-reported.transitive-contradiction",
    title: "a transitively-impossible hard-rule set is reported as a conflict, not silently forced",
    objective:
      "Confirms that when must-sit-together rules force three guests into one group, but two of them also have a must-not-sit-together rule between them, generation refuses to run and reports the conflict rather than violating one of the rules.",
    expectedOutcome:
      "The Seating plan tab shows a rule-conflict message naming the two guests who can't both be forced together and kept apart, and no new plan version is created.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, evidence, context }, testInfo) => {
    const planTabPage = new PlanTabPage(page);
    const guestA = uniquePersonName(testInfo.workerIndex);
    const guestB = uniquePersonName(testInfo.workerIndex);
    const guestC = uniquePersonName(testInfo.workerIndex);

    await test.step("Arrange: A-B and B-C must sit together (forcing all three into one group), while A-C must not sit together", async () => {
      const a = await weddingData.createGuest(managedWedding.id, guestA);
      const b = await weddingData.createGuest(managedWedding.id, guestB);
      const c = await weddingData.createGuest(managedWedding.id, guestC);
      await weddingData.createRelationship(managedWedding.id, a.id, b.id, "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, b.id, c.id, "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, a.id, c.id, "MUST_NOT_SIT_TOGETHER");
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
    });

    const planVersionsBefore = await test.step("Arrange: record how many plan versions exist before generating", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions`);
      expect(res.ok()).toBe(true);
      const { planVersions } = (await res.json()) as { planVersions: unknown[] };
      return planVersions.length;
    });

    await test.step("Act: attempt to generate a plan", async () => {
      await planTabPage.goto(managedWedding.id);
      await planTabPage.generate();
    });

    await test.step("Assert: the conflict is reported, naming both guests", async () => {
      await expect(planTabPage.textLocator("These rule conflicts need to be fixed first")).toBeVisible();
      // The engine doesn't promise which of the two conflicting guests it names first (a real run
      // showed the opposite order from an earlier run of this same scenario), so match either order
      // rather than asserting on that implementation detail.
      const fullNameA = `${guestA.firstName} ${guestA.lastName}`;
      const fullNameC = `${guestC.firstName} ${guestC.lastName}`;
      await expect(
        planTabPage.textLocator(new RegExp(`(${fullNameA} and ${fullNameC})|(${fullNameC} and ${fullNameA})`)),
      ).toBeVisible();
    });

    await test.step("Assert: no new plan version was created", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions`);
      expect(res.ok()).toBe(true);
      const { planVersions } = (await res.json()) as { planVersions: unknown[] };
      expect(planVersions.length).toBe(planVersionsBefore);
    });

    await evidence.checkpoint(
      "impossible-rule-set-reported",
      `The conflict report names ${guestA.firstName} ${guestA.lastName} and ${guestC.firstName} ${guestC.lastName}, and no plan version was saved.`,
    );
  },
);
