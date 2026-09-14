/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-023 ("Must-Sit-Together is enforced by
 * both generation and manual editing").
 *
 * The manual-editing half of this AC -- attempting to separate one member of a forced-together
 * unit is blocked -- is already fully covered by TS-54's
 * cross-cutting-invariant.hard-rules-block-every-direct-manual-move.spec.ts (that test's own doc
 * comment explains why the blocking reason is always "capacity", never a distinct "separation"
 * error: the manual-move endpoint always moves a unit's *entire* forced-together group as one
 * atomic move, so a request naming only one member can never actually separate them). Not
 * re-authored here.
 *
 * What TS-54 doesn't cover, and no other existing test does either: whether *generation itself*
 * actually treats a transitive chain of MUST_SIT_TOGETHER rules (A-B, B-C) as one three-guest
 * group that all land at the same table. Traced directly against seating-engine.ts's UnionFind
 * step -- every guest is grouped by MUST_SIT_TOGETHER edges into one `Unit` *before* any table
 * assignment happens, so A, B, and C here are placed as a single atomic bin-packing item, never
 * split -- confirmed here by asserting all three share one tableId after generation.
 *
 * The AC's other sub-clause -- "when no eligible table can hold the group, rule creation or
 * editing is blocked with the capacity or eligibility conflict identified" -- is not implemented:
 * `createRelationship` (packages/db/src/queries/relationships.ts) never looks at tables or
 * capacity at all when saving a MUST_SIT_TOGETHER rule. That's a real gap against this AC's
 * literal wording, not something this test works around by asserting a rule-creation-time block
 * that doesn't exist.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "rules.must-sit-together-groups-share-one-table.transitive-three-guest-chain",
    title: "a transitive chain of Must-Sit-Together rules seats all three guests at one table",
    objective:
      "Confirms that when Guest A must sit with Guest B, and Guest B must sit with Guest C, generation treats all three as one group and seats them at a single table together, rather than only honoring the direct pairs.",
    expectedOutcome:
      "The generated plan is complete, and Guests A, B, and C are all assigned to the exact same table.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let idA = "";
    let idB = "";
    let idC = "";

    await test.step("Arrange: A-B and B-C must sit together (a transitive chain, no direct A-C rule)", async () => {
      idA = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idB = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idC = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      await weddingData.createRelationship(managedWedding.id, idA, idB, "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, idB, idC, "MUST_SIT_TOGETHER");
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
    });

    const planVersion = await test.step("Act: generate a plan", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        planVersion: { isComplete: boolean; assignments: { guestId: string; tableId: string }[] };
      };
      return body.planVersion;
    });

    await test.step("Assert: the plan is complete and all three guests share one table", async () => {
      expect(planVersion.isComplete).toBe(true);
      const tableOf = (guestId: string) => planVersion.assignments.find((a) => a.guestId === guestId)?.tableId;
      const tableA = tableOf(idA);
      expect(tableA).toBeTruthy();
      expect(tableOf(idB)).toBe(tableA);
      expect(tableOf(idC)).toBe(tableA);
    });
  },
);
