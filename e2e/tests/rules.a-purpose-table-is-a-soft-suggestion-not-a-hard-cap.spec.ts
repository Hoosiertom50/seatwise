/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-030 ("A Purpose table is a soft
 * suggestion, not a hard cap"). Two scenarios (two managedWedding fixtures), because "children
 * are favored, with overflow placed elsewhere" and "a nonmatching guest can still be seated
 * there when it's the only room left" require opposite capacity pressure at the Purpose table --
 * once it fills from matching guests it stays full for the rest of that placement run, so the two
 * halves can't both happen in one generate() call. Both scenarios' exact per-guest placements were
 * hand-derived from `attemptPlace`'s scoring (packages/shared/src/seating-engine.ts:
 * `purposeCriterionBonus: 6`, `purposeCriterionMismatchPenalty: 2`) and then empirically confirmed
 * against the real running app before writing these assertions.
 *
 * Test 1 uses three Child guests and two Adult guests against a 2-seat "Kids Table" (Age
 * Category = Child) and a 3-seat plain table (zero slack, five guests total): the criterion's +6
 * bonus per matching guest always beats every other table's neutral 0, so the first two Child
 * guests (by the app's own guest-list ORDER BY lastName, firstName -- controlled here via last
 * name prefixes) fill the Kids Table, and the third Child guest overflows to the plain table
 * alongside both Adults, generation completing successfully throughout.
 *
 * Test 2 uses zero Child guests at all and two Adults against a 1-seat Kids Table and a 1-seat
 * plain table (zero slack): with no matching guest anywhere to earn the criterion's bonus, the
 * table behaves exactly like an ordinary table -- the first Adult takes whichever table wins the
 * (Kids-Table-irrelevant) tie, and the second Adult is forced onto the Kids Table once the other
 * table is full, despite the -2 mismatch penalty, since it's the only table with room. This
 * simultaneously proves the free-text "Kids' Table" label carries no algorithmic weight of its own
 * (the score report's own matchingGuestsTotal for it is 0) and that a nonmatching guest is never
 * blocked from a Purpose table.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";

interface PurposeTableScoreEntry {
  tableId: string;
  tableLabel: string;
  criterionType: string;
  criterionValue: string;
  matchingGuestsSeatedHere: number;
  matchingGuestsTotal: number;
}

interface GenerateResponse {
  planVersion: { isComplete: boolean; assignments: { guestId: string; tableId: string }[] };
  scoreReport: { purposeTables: PurposeTableScoreEntry[] };
}

defineQualityTest(
  {
    id: "rules.a-purpose-table-is-a-soft-suggestion-not-a-hard-cap.children-favored-overflow-elsewhere",
    title: "a Kids Table's Age-Category criterion favors children, but overflow children are placed elsewhere and generation still completes",
    objective:
      "Confirms that a table with the Age Category = Child structured criterion is favored for Attending children, that a child who doesn't fit once the table is full is placed at another table instead of being left unassigned, and that generation completing at all never depends on every child fitting at the Kids Table.",
    expectedOutcome:
      "The two guests the criterion table has room for are both children; the third (overflow) child and both adults are at the other table; the plan is complete; the score report names the Kids Table with 2 of 3 matching children seated there.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    let idKid1 = "";
    let idKid2 = "";
    let idKid3 = "";
    let idAdult1 = "";
    let idAdult2 = "";
    let kidsTableId = "";
    let otherTableId = "";

    await test.step("Arrange: 3 Child guests, 2 Adult guests; a 2-seat Kids Table (criterion Age Category = Child) and a 3-seat plain table", async () => {
      idKid1 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `KidA-${token}`, ageCategory: "CHILD" })
      ).id;
      idKid2 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `KidB-${token}`, ageCategory: "CHILD" })
      ).id;
      idKid3 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `KidC-${token}`, ageCategory: "CHILD" })
      ).id;
      idAdult1 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `ZultA-${token}`, ageCategory: "ADULT" })
      ).id;
      idAdult2 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `ZultB-${token}`, ageCategory: "ADULT" })
      ).id;
      kidsTableId = (
        await weddingData.createTable(managedWedding.id, {
          label: "Kids Table",
          capacity: 2,
          purpose: "Kids' Table",
          purposeCriterionType: "AGE_CATEGORY",
          purposeCriterionValue: "CHILD",
        })
      ).id;
      otherTableId = (await weddingData.createTable(managedWedding.id, { label: "Reception Table", capacity: 3 })).id;
    });

    const body = await test.step("Act: generate a plan", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      return (await res.json()) as GenerateResponse;
    });

    await test.step("Assert: the first two children are at the Kids Table, the third child and both adults are at the other table, and the plan is complete", async () => {
      expect(body.planVersion.isComplete).toBe(true);
      const tableOf = (id: string) => body.planVersion.assignments.find((a) => a.guestId === id)?.tableId;
      expect(tableOf(idKid1)).toBe(kidsTableId);
      expect(tableOf(idKid2)).toBe(kidsTableId);
      expect(tableOf(idKid3)).toBe(otherTableId);
      expect(tableOf(idAdult1)).toBe(otherTableId);
      expect(tableOf(idAdult2)).toBe(otherTableId);
    });

    await test.step("Assert: the score report names the Kids Table with 2 of 3 matching children seated there", async () => {
      const entry = body.scoreReport.purposeTables.find((p) => p.tableId === kidsTableId);
      expect(entry).toMatchObject({
        criterionType: "AGE_CATEGORY",
        criterionValue: "CHILD",
        matchingGuestsSeatedHere: 2,
        matchingGuestsTotal: 3,
      });
    });
  },
);

defineQualityTest(
  {
    id: "rules.a-purpose-table-is-a-soft-suggestion-not-a-hard-cap.nonmatching-guest-can-be-seated-there",
    title: "a nonmatching guest can still be seated at a Purpose table, and its free-text label alone has no algorithmic effect",
    objective:
      "Confirms a Purpose table never refuses a nonmatching guest -- with no children in the wedding at all, an Adult guest is forced onto the Kids Table once the only other table is full, and the score report shows zero matching guests there, proving the free-text 'Kids' Table' label carries no weight beyond its structured criterion.",
    expectedOutcome:
      "Both adults are seated (isComplete: true); the second is at the Kids Table despite not matching its criterion; the score report's entry for it shows matchingGuestsSeatedHere: 0 of matchingGuestsTotal: 0.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    let idAdult1 = "";
    let idAdult2 = "";
    let kidsTableId = "";
    let otherTableId = "";

    await test.step("Arrange: 2 Adult guests (no Child guests at all), a 1-seat Kids Table and a 1-seat plain table", async () => {
      idAdult1 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `ZultA-${token}`, ageCategory: "ADULT" })
      ).id;
      idAdult2 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `ZultB-${token}`, ageCategory: "ADULT" })
      ).id;
      kidsTableId = (
        await weddingData.createTable(managedWedding.id, {
          label: "Kids Table",
          capacity: 1,
          purpose: "Kids' Table",
          purposeCriterionType: "AGE_CATEGORY",
          purposeCriterionValue: "CHILD",
        })
      ).id;
      otherTableId = (await weddingData.createTable(managedWedding.id, { label: "Other Table", capacity: 1 })).id;
    });

    const body = await test.step("Act: generate a plan", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      return (await res.json()) as GenerateResponse;
    });

    await test.step("Assert: both adults are seated, one of them at the Kids Table despite not matching its criterion", async () => {
      expect(body.planVersion.isComplete).toBe(true);
      const tableOf = (id: string) => body.planVersion.assignments.find((a) => a.guestId === id)?.tableId;
      const seatedTableIds = new Set([tableOf(idAdult1), tableOf(idAdult2)]);
      expect(seatedTableIds).toEqual(new Set([kidsTableId, otherTableId]));
    });

    await test.step("Assert: the score report shows zero matching guests at the Kids Table -- the label alone did nothing", async () => {
      const entry = body.scoreReport.purposeTables.find((p) => p.tableId === kidsTableId);
      expect(entry).toMatchObject({ matchingGuestsSeatedHere: 0, matchingGuestsTotal: 0 });
    });
  },
);
