/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-025 ("Prefer-Near / Prefer-Avoid influence
 * generation but never block a manual move"). Note the app's actual enum value for "Prefer-Avoid"
 * is `AVOID` (there is no `PREFER_AVOID` anywhere in the schema, DB, or UI -- confirmed directly
 * against packages/shared/src/schemas/relationship.ts).
 *
 * Generation already proves PREFER_NEAR pulls a pair together in
 * seat-assignment.generate-produces-complete-plan-with-score-report.spec.ts (TS-38) -- not
 * re-authored here. This test adds the half nothing else covers: that AVOID pulls a pair *apart*
 * during generation (when there's room to do so), and -- the real point of this AC -- that an
 * authorized manual move working against either soft preference is never blocked.
 *
 * Reading packages/db/src/queries/plan-versions.ts's `moveGuestAssignment` directly turned up an
 * asymmetry the AC's literal wording doesn't anticipate: only AVOID is checked for a non-blocking
 * warning on a manual move (`if (r.type === "MUST_NOT_SIT_TOGETHER" || r.type === "AVOID")`) --
 * PREFER_NEAR is never checked there at all, so a manual move that separates a Prefer-Near pair
 * succeeds completely silently, with no warning of any kind. Both halves of the AC's core claim
 * ("never blocks a manual move") hold for both rule types; only the "with a visible non-blocking
 * warning" qualifier holds for AVOID and not for PREFER_NEAR. This test proves the real behavior
 * for both rather than asserting the AC's warning claim where it doesn't actually apply.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface Assignment {
  guestId: string;
  tableId: string;
}

defineQualityTest(
  {
    id: "rules.soft-preferences-influence-generation-but-never-block-a-manual-move.avoid-and-prefer-near",
    title: "Avoid separates a pair during generation, and a manual move against either soft preference always succeeds",
    objective:
      "Confirms generation seats an Avoid pair at different tables when there's room to do so, and that manually moving a guest in a way that works against an Avoid or Prefer-Near preference always succeeds (200) -- with a specific non-blocking warning for Avoid, and silently (no warning) for Prefer-Near, since the app only checks Avoid on a manual move.",
    expectedOutcome:
      "Generation seats the Avoid pair at different tables. A manual move that co-seats the Avoid pair succeeds with a warning naming both guests and the applied weighting-configuration version. A manual move that separates the Prefer-Near pair also succeeds, with an empty warnings array.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let idAvoidC = "";
    let idAvoidD = "";
    let idPreferE = "";
    let idPreferF = "";
    let tableIdA = "";
    let tableIdB = "";
    let planVersionId = "";

    await test.step("Arrange: an Avoid pair (C, D) and a Prefer-Near pair (E, F), two tables with plenty of room", async () => {
      idAvoidC = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idAvoidD = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idPreferE = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idPreferF = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      await weddingData.createRelationship(managedWedding.id, idAvoidC, idAvoidD, "AVOID");
      await weddingData.createRelationship(managedWedding.id, idPreferE, idPreferF, "PREFER_NEAR");
      tableIdA = (await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 4 })).id;
      tableIdB = (await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 4 })).id;
    });

    const planVersion = await test.step("Act: generate a plan", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        planVersion: { id: string; isComplete: boolean; assignments: Assignment[] };
      };
      planVersionId = body.planVersion.id;
      return body.planVersion;
    });

    const tableOf = (id: string) => planVersion.assignments.find((a) => a.guestId === id)?.tableId;

    await test.step("Assert: generation seats the Avoid pair at different tables", async () => {
      expect(planVersion.isComplete).toBe(true);
      expect(tableOf(idAvoidC)).toBeTruthy();
      expect(tableOf(idAvoidD)).not.toBe(tableOf(idAvoidC));
    });

    await test.step("Assert: a manual move that co-seats the Avoid pair succeeds with a specific warning", async () => {
      const cTable = tableOf(idAvoidC)!;
      const res = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
        { data: { guestId: idAvoidD, tableId: cTable } },
      );
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings.length).toBe(1);
      expect(body.warnings[0]).toContain("despite an \"avoid\" preference between them");
      expect(body.warnings[0]).toContain("weighting-configuration version");
    });

    await test.step("Arrange: force the Prefer-Near pair together first, regardless of where generation put them", async () => {
      const eTable = tableOf(idPreferE)!;
      const res = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
        { data: { guestId: idPreferF, tableId: eTable } },
      );
      expect(res.status()).toBe(200);
    });

    await test.step("Assert: a manual move that separates the Prefer-Near pair succeeds silently -- no warning at all", async () => {
      const eTable = tableOf(idPreferE)!;
      const otherTableId = eTable === tableIdA ? tableIdB : tableIdA;
      const res = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
        { data: { guestId: idPreferF, tableId: otherTableId } },
      );
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings).toEqual([]);
    });
  },
);
