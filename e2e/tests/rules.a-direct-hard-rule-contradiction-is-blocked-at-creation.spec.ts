/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-027 ("Creating a hard rule that
 * contradicts an existing hard rule is blocked").
 *
 * The workbook's precondition describes a *transitive* contradiction (A-B and B-C both
 * must-sit-together, then attempting A-C must-not-sit-together) and expects it "blocked" "at
 * creation" with a message identifying all three guests and the existing transitive rules.
 * TS-181: `createRelationship` (packages/db/src/queries/relationships.ts) now refuses that
 * transitive case at creation too, naming the guests and the chain -- covered by TS-38's
 * seat-assignment.impossible-hard-rule-set-is-reported.spec.ts (same A-B/B-C/A-C scenario, through
 * the Seating rules tab) and TS-181's
 * seat-assignment.restricted-lists-rules-and-removals-keep-the-plan-consistent.spec.ts (both
 * directions). Not re-authored here.
 *
 * What *is* implemented, and untested until now, is the direct case this AC also describes in
 * miniature: two guests with one hard rule already between them, and an attempt to add the
 * *opposite* hard rule for that exact same pair. That's the one this test proves, at the API
 * level (409, with a message naming the existing rule type) since there's no dedicated create-time
 * error UI beyond the existing Seating rules tab's own inline error text (which just renders
 * whatever the API returns as-is).
 *
 * The AC's closing clause ("the same validation applies to contradictions involving Restricted
 * Table, accessible-table, and capacity requirements") is now partly covered: TS-173/TS-181 refuse
 * a rule that clashes with a Restricted table's required-guest list (tested in the two specs named
 * above); accessibility and capacity still aren't looked at when a rule is saved.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "rules.a-direct-hard-rule-contradiction-is-blocked-at-creation.opposite-hard-type-same-pair",
    title: "creating the opposite hard rule for a pair that already has one is blocked at creation",
    objective:
      "Confirms that when two guests already have a Must-Sit-Together rule between them, attempting to create a Must-Not-Sit-Together rule for that same exact pair is refused outright -- and that the reverse (Must-Not-Sit-Together already present, then attempting Must-Sit-Together) is refused too -- with neither attempt creating a second, conflicting rule.",
    expectedOutcome:
      "Both creation attempts return 409 with a message naming the existing conflicting rule type, and the wedding's rule list still contains only the one originally-created rule for each pair.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let idA = "";
    let idB = "";
    let idC = "";
    let idD = "";

    await test.step("Arrange: A-B already must sit together; C-D already must not sit together", async () => {
      idA = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idB = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idC = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idD = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      await weddingData.createRelationship(managedWedding.id, idA, idB, "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, idC, idD, "MUST_NOT_SIT_TOGETHER");
    });

    await test.step("Assert: creating Must-Not-Sit-Together for A-B (opposite of the existing rule) is blocked", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/relationships`, {
        data: { guestAId: idA, guestBId: idB, type: "MUST_NOT_SIT_TOGETHER" },
      });
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("conflicting rule");
      expect(body.error).toContain("must sit together");
    });

    await test.step("Assert: creating Must-Sit-Together for C-D (opposite of the existing rule) is blocked", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/relationships`, {
        data: { guestAId: idC, guestBId: idD, type: "MUST_SIT_TOGETHER" },
      });
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("conflicting rule");
      expect(body.error).toContain("must not sit together");
    });

    await test.step("Assert: exactly the two original rules exist -- neither blocked attempt created a second rule", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/relationships`);
      const { relationships } = (await res.json()) as { relationships: { guestAId: string; guestBId: string; type: string }[] };
      const abRules = relationships.filter(
        (r) => [r.guestAId, r.guestBId].sort().join() === [idA, idB].sort().join(),
      );
      const cdRules = relationships.filter(
        (r) => [r.guestAId, r.guestBId].sort().join() === [idC, idD].sort().join(),
      );
      expect(abRules).toHaveLength(1);
      expect(abRules[0].type).toBe("MUST_SIT_TOGETHER");
      expect(cdRules).toHaveLength(1);
      expect(cdRules[0].type).toBe("MUST_NOT_SIT_TOGETHER");
    });
  },
);
