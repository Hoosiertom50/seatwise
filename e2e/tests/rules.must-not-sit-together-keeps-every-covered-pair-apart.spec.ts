/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-024 ("Must-Not-Sit-Together is enforced
 * by both generation and manual editing").
 *
 * The manual-editing half -- attempting to seat a must-not-sit-together pair together is blocked
 * -- is already fully covered by TS-54's
 * cross-cutting-invariant.hard-rules-block-every-direct-manual-move.spec.ts for a single pair.
 * Not re-authored here.
 *
 * What's new: the workbook's precondition describes a rule "covering Guests A, B, and C" -- since
 * the schema only ever models a relationship as exactly two guests (packages/shared/src/schemas/
 * relationship.ts), the only way to express "A cannot share a table with B or C, and B cannot
 * share a table with C" is three separate pairwise MUST_NOT_SIT_TOGETHER rules (A-B, A-C, B-C).
 * No existing test exercises *generation* with more than one MUST_NOT_SIT_TOGETHER pair at once --
 * this proves the engine's cross-unit hard filter (`hasMustNotConflict` in seating-engine.ts,
 * which excludes any table already holding someone the incoming unit must not sit with) correctly
 * keeps all three mutually apart, not just one pair.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "rules.must-not-sit-together-keeps-every-covered-pair-apart.three-way-mutual-exclusion",
    title: "three guests who mutually must not sit together are generated onto three distinct tables",
    objective:
      "Confirms that when A-B, A-C, and B-C are all separately marked must-not-sit-together, generation seats all three guests at distinct tables rather than allowing any one pair to share a table.",
    expectedOutcome:
      "The generated plan is complete, and Guests A, B, and C each end up at a different table from the other two.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let idA = "";
    let idB = "";
    let idC = "";

    await test.step("Arrange: A, B, and C mutually must not sit together, with three single-seat tables", async () => {
      idA = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idB = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idC = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      await weddingData.createRelationship(managedWedding.id, idA, idB, "MUST_NOT_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, idA, idC, "MUST_NOT_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, idB, idC, "MUST_NOT_SIT_TOGETHER");
      await weddingData.quickCreateTables(managedWedding.id, { count: 3, capacity: 1 });
    });

    const planVersion = await test.step("Act: generate a plan", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        planVersion: { isComplete: boolean; assignments: { guestId: string; tableId: string }[] };
      };
      return body.planVersion;
    });

    await test.step("Assert: the plan is complete and all three guests are at three distinct tables", async () => {
      expect(planVersion.isComplete).toBe(true);
      const tableOf = (guestId: string) => planVersion.assignments.find((a) => a.guestId === guestId)?.tableId;
      const tableA = tableOf(idA);
      const tableB = tableOf(idB);
      const tableC = tableOf(idC);
      expect(tableA).toBeTruthy();
      expect(tableB).toBeTruthy();
      expect(tableC).toBeTruthy();
      expect(new Set([tableA, tableB, tableC]).size).toBe(3);
    });
  },
);
