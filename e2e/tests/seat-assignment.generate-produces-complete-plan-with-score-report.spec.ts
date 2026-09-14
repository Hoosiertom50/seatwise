/**
 * TS-38 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — converts AC-040 ("One action produces a complete
 * first-draft plan") and AC-042 ("Generation reports how well soft preferences were satisfied").
 * Folded into one test rather than two: both describe the same single "click Generate new plan"
 * action's outcome -- completeness of the assignment and the accompanying soft-preference score
 * report -- not two independent behaviors (see the pw-author-test skill's "extend vs. separate"
 * guidance).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "seat-assignment.generate-produces-complete-plan-with-score-report.happy-path",
    title: "one Generate action produces a complete plan and a soft-preference score report",
    objective:
      "Confirms that generating a plan for a satisfiable wedding (with both Attending and Not Attending guests, and a PREFER_NEAR soft preference) seats every Attending guest, ignores the Not Attending guest entirely, and shows a soft-preference score report -- all from one generation request.",
    expectedOutcome:
      "The Seating plan tab shows no unassigned guests, the Not Attending guest never appears in any table's list, and a score report is displayed naming the PREFER_NEAR pair's outcome.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:critical", "@suite:smoke", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, evidence }, testInfo) => {
    const planTabPage = new PlanTabPage(page);
    const attendingA = uniquePersonName(testInfo.workerIndex);
    const attendingB = uniquePersonName(testInfo.workerIndex);
    const notAttending = uniquePersonName(testInfo.workerIndex);

    await test.step("Arrange: two Attending guests with a PREFER_NEAR rule, one Not Attending guest, and one table with room for everyone", async () => {
      const guestA = await weddingData.createGuest(managedWedding.id, attendingA);
      const guestB = await weddingData.createGuest(managedWedding.id, attendingB);
      await weddingData.createGuest(managedWedding.id, { ...notAttending, dayOfAttendance: "NOT_ATTENDING" });
      await weddingData.createRelationship(managedWedding.id, guestA.id, guestB.id, "PREFER_NEAR");
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
    });

    await test.step("Act: generate a new plan", async () => {
      await planTabPage.goto(managedWedding.id);
      await planTabPage.generate();
    });

    await test.step("Assert: both Attending guests are seated (0 unassigned), and the Not Attending guest never appears", async () => {
      await expect(planTabPage.textLocator("0 unassigned")).toBeVisible();
      await expect(planTabPage.textLocator(`${notAttending.firstName} ${notAttending.lastName}`)).not.toBeVisible();
      await expect(planTabPage.textLocator(`${attendingA.firstName} ${attendingA.lastName}`, true)).toBeVisible();
      await expect(planTabPage.textLocator(`${attendingB.firstName} ${attendingB.lastName}`, true)).toBeVisible();
    });

    await test.step("Assert: a soft-preference score report names the PREFER_NEAR pair's outcome", async () => {
      await expect(planTabPage.textLocator("Soft-preference results")).toBeVisible();
      // The engine doesn't promise which of the pair it names first in the report (confirmed by a
      // real run failing with the opposite order from what a fixed-order assertion expected --
      // the same non-determinism already fixed in impossible-hard-rule-set-is-reported.spec.ts),
      // so match either order rather than asserting on that implementation detail.
      const fullNameA = `${attendingA.firstName} ${attendingA.lastName}`;
      const fullNameB = `${attendingB.firstName} ${attendingB.lastName}`;
      await expect(
        planTabPage.textLocator(new RegExp(`(${fullNameA} and ${fullNameB})|(${fullNameB} and ${fullNameA})`)),
      ).toBeVisible();
    });

    await evidence.checkpoint(
      "plan-generated-complete-with-score-report",
      "Both Attending guests are seated, the Not Attending guest is absent, and the score report names the PREFER_NEAR pair.",
    );
  },
);
