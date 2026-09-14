/**
 * TS-38 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — converts AC-043 ("Generation can be re-run repeatedly")
 * and AC-045 ("Each generation run is saved as a distinct, retrievable version"). Folded into one
 * test: the workbook's own AC-045 steps ("Select Make Current and run generation once... Select
 * Save as Comparison Draft and run generation a second time") already exercise a changed input
 * between the two runs, which is exactly AC-043's own scenario -- these aren't two independent
 * behaviors, they're the same re-run-and-compare-versions flow.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { uniquePersonName } from "../data/ids.js";

interface PlanVersionSummary {
  id: string;
  isCurrent: boolean;
}
interface PlanVersionDetail {
  id: string;
  assignments: { guestName: string }[];
}

defineQualityTest(
  {
    id: "seat-assignment.regeneration-creates-distinct-retrievable-versions.make-current-vs-draft",
    title: "re-running generation with a changed input creates a separate, retrievable version",
    objective:
      "Confirms that generating once (Make Current) and again after adding a guest (Save as Comparison Draft) produces two distinct, independently retrievable plan versions, that the second run used the guest list current at its own start, and that the draft never replaces the Current version.",
    expectedOutcome:
      "Two plan versions exist: the first is still Current and doesn't include the guest added afterward; the second is a non-current draft that does include it.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context, evidence }, testInfo) => {
    const planTabPage = new PlanTabPage(page);
    const guestOne = uniquePersonName(testInfo.workerIndex);
    const guestTwo = uniquePersonName(testInfo.workerIndex);

    await test.step("Arrange: one guest and one table with room for a second guest added later", async () => {
      await weddingData.createGuest(managedWedding.id, guestOne);
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
      await planTabPage.goto(managedWedding.id);
    });

    await test.step("Act: generate once with Make Current (the default)", async () => {
      await planTabPage.generate(false);
    });

    await test.step("Act: add a second guest, then generate again with Save as Comparison Draft", async () => {
      await weddingData.createGuest(managedWedding.id, guestTwo);
      await planTabPage.generate(true);
    });

    const { currentVersionId, draftVersionId } = await test.step("Assert: exactly two plan versions exist, and only one is Current", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions`);
      expect(res.ok()).toBe(true);
      const { planVersions } = (await res.json()) as { planVersions: PlanVersionSummary[] };
      expect(planVersions.length).toBe(2);
      const current = planVersions.filter((v) => v.isCurrent);
      expect(current.length).toBe(1);
      const draft = planVersions.find((v) => v.id !== current[0].id);
      expect(draft).toBeDefined();
      return { currentVersionId: current[0].id, draftVersionId: draft!.id };
    });

    await test.step("Assert: the Current version (the first run) doesn't include the guest added afterward", async () => {
      const res = await context.request.get(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${currentVersionId}`,
      );
      expect(res.ok()).toBe(true);
      const { planVersion } = (await res.json()) as { planVersion: PlanVersionDetail };
      const names = planVersion.assignments.map((a) => a.guestName);
      expect(names).toContain(`${guestOne.firstName} ${guestOne.lastName}`);
      expect(names).not.toContain(`${guestTwo.firstName} ${guestTwo.lastName}`);
    });

    await test.step("Assert: the draft version (the second run) used the guest list current at its own start", async () => {
      const res = await context.request.get(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${draftVersionId}`,
      );
      expect(res.ok()).toBe(true);
      const { planVersion } = (await res.json()) as { planVersion: PlanVersionDetail };
      const names = planVersion.assignments.map((a) => a.guestName);
      expect(names).toContain(`${guestOne.firstName} ${guestOne.lastName}`);
      expect(names).toContain(`${guestTwo.firstName} ${guestTwo.lastName}`);
    });

    await evidence.checkpoint(
      "two-distinct-versions-retrievable",
      "The Current version and the comparison draft are both retrievable, distinct, and reflect the guest list at their own respective run.",
    );
  },
);
