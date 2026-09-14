/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-026 ("Side-Mixing levels change
 * generation behavior; a table can override"). Two separate scenarios (two managedWedding
 * fixtures, one per defineQualityTest call), since forcing every sub-claim into one continuous
 * regenerate sequence over a single shared dataset produces capacity interactions between the
 * two halves that make the plan version's outcome depend on subtle tie-break order rather than on
 * the setting being tested -- confirmed by hand-deriving the engine's scoring
 * (packages/shared/src/seating-engine.ts's `attemptPlace`) and then empirically verifying every
 * number below against the real running app before writing these assertions (not just inferred
 * from reading the code).
 *
 * There is no UI anywhere to change a wedding's sideMixing setting (checked the wedding-creation
 * form, the wedding-detail shell, and every weddings/[weddingId]/components/*.tsx -- it's
 * display-only everywhere in the frontend) -- both tests set it via a raw PATCH to
 * `/api/v1/weddings/:id` (OWNER-only access, which the managedWedding fixture's own account
 * always has).
 *
 * Test 1 uses two Bride guests, two Groom guests, and one Both guest, two same-capacity tables
 * labeled so their alphabetical order is stable across every generate call (table order and
 * guest-name order both feed the engine's tie-break: guests are queried `ORDER BY lastName,
 * firstName` and tables `ORDER BY label`, so this test's guest last names and table labels are
 * chosen specifically to make every tie-break deterministic, not left to chance). Each of the
 * three Side-Mixing settings produces a distinct, hand-derived-and-empirically-confirmed pattern
 * of mixedTableCount/singleSideTableCount; the Both-marked guest's presence never changes any of
 * those three counts, directly demonstrating "guests marked Both are excluded from both
 * configured-side counts."
 *
 * Test 2 proves the Single-Side-Only table-level override: with three Brides and one Groom
 * split across a 3-seat Single-Side-Only table and a 1-seat plain table, the Groom is forced onto
 * the Single-Side-Only table once the plain table fills up -- a genuine unmet Single-Side-Only
 * preference, not one that happens to go unexercised. Generation still succeeds completely
 * (isComplete: true) and reports the violation as a warning and a scoreReport count, never a
 * block -- exactly AC-026's "does not by itself cause generation to fail."
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";

interface SideMixingScoreReport {
  setting: string;
  mixedTableCount: number;
  singleSideTableCount: number;
  singleSideOnlyViolations: number;
}

interface GenerateResponse {
  planVersion: {
    sideMixingSetting: string;
    ruleConfigVersion: number;
    isComplete: boolean;
    warnings: string[];
    assignments: { guestId: string; tableId: string }[];
  };
  scoreReport: { ruleConfigVersion: number; sideMixing: SideMixingScoreReport };
}

defineQualityTest(
  {
    id: "rules.side-mixing-levels-change-generation-behavior.three-settings-compared",
    title: "each Side-Mixing setting produces a distinct, correctly-computed table composition, excluding Both guests from the counts",
    objective:
      "Confirms that regenerating the same fixed dataset under Keep Sides Separate, Balanced Mix, and Fully Mixed each records the selected setting and weighting-configuration version on the plan version, and produces the documented mixed/single-side table counts for that setting -- unaffected by a Both-marked guest sharing a table with either side.",
    expectedOutcome:
      "Keep Sides Separate fully segregates the two sides (0 mixed, 2 single-side tables). Balanced Mix produces one mixed table. Fully Mixed produces two mixed tables. In every case the Both-marked guest's own table membership never changes the mixed/single-side counts.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    let idB1 = "";
    let idB2 = "";
    let idG1 = "";
    let idG2 = "";
    let idBoth = "";

    await test.step("Arrange: two Bride guests, two Groom guests, one Both guest, and two capacity-4 tables (last names and table labels chosen to make processing order deterministic)", async () => {
      idB1 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `BrideA-${token}`, side: "BRIDE" })
      ).id;
      idB2 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `BrideB-${token}`, side: "BRIDE" })
      ).id;
      idG1 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `GroomA-${token}`, side: "GROOM" })
      ).id;
      idG2 = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `GroomB-${token}`, side: "GROOM" })
      ).id;
      idBoth = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `ZBoth-${token}`, side: "BOTH" })
      ).id;
      await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 4 });
      await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 4 });
    });

    const generateUnder = async (sideMixing: "KEEP_SEPARATE" | "BALANCED_MIX" | "FULLY_MIXED") => {
      await weddingData.updateWedding(managedWedding.id, { sideMixing });
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      return (await res.json()) as GenerateResponse;
    };

    await test.step("Act + Assert: Keep Sides Separate fully segregates the two sides", async () => {
      const body = await generateUnder("KEEP_SEPARATE");
      expect(body.planVersion.sideMixingSetting).toBe("KEEP_SEPARATE");
      expect(body.planVersion.ruleConfigVersion).toBe(body.scoreReport.ruleConfigVersion);
      expect(body.planVersion.isComplete).toBe(true);
      expect(body.scoreReport.sideMixing).toEqual({
        setting: "KEEP_SEPARATE",
        mixedTableCount: 0,
        singleSideTableCount: 2,
        singleSideOnlyViolations: 0,
      });
      // The Both guest always lands on the same table as both Brides here -- proving their
      // presence doesn't turn that all-Bride table into a "mixed" one.
      const tableOf = (id: string) => body.planVersion.assignments.find((a) => a.guestId === id)?.tableId;
      expect(tableOf(idBoth)).toBe(tableOf(idB1));
      expect(tableOf(idB2)).toBe(tableOf(idB1));
    });

    await test.step("Act + Assert: Balanced Mix produces exactly one mixed table", async () => {
      const body = await generateUnder("BALANCED_MIX");
      expect(body.planVersion.sideMixingSetting).toBe("BALANCED_MIX");
      expect(body.planVersion.isComplete).toBe(true);
      expect(body.scoreReport.sideMixing).toEqual({
        setting: "BALANCED_MIX",
        mixedTableCount: 1,
        singleSideTableCount: 0,
        singleSideOnlyViolations: 0,
      });
    });

    await test.step("Act + Assert: Fully Mixed produces two mixed tables", async () => {
      const body = await generateUnder("FULLY_MIXED");
      expect(body.planVersion.sideMixingSetting).toBe("FULLY_MIXED");
      expect(body.planVersion.isComplete).toBe(true);
      expect(body.scoreReport.sideMixing).toEqual({
        setting: "FULLY_MIXED",
        mixedTableCount: 2,
        singleSideTableCount: 0,
        singleSideOnlyViolations: 0,
      });
    });
  },
);

defineQualityTest(
  {
    id: "rules.side-mixing-levels-change-generation-behavior.single-side-only-table-override",
    title: "a Single-Side-Only table's unmet preference is reported as a warning, never a generation failure",
    objective:
      "Confirms that when a table is marked Single-Side-Only and capacity forces a guest from the other side onto it anyway, generation still completes successfully, and the violation is surfaced as a non-blocking warning and counted in the score report -- not treated as a hard rule.",
    expectedOutcome:
      "Generation is complete (isComplete: true) with a warning naming the Groom guest and the Single-Side-Only table, and the score report counts exactly one Single-Side-Only violation.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    let idGroom = "";
    let tableIdSSO = "";

    await test.step("Arrange: three Brides and one Groom; a 3-seat Single-Side-Only table and a 1-seat plain table (zero slack)", async () => {
      await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `BrideA-${token}`, side: "BRIDE" });
      await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `BrideB-${token}`, side: "BRIDE" });
      await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `BrideC-${token}`, side: "BRIDE" });
      idGroom = (
        await weddingData.createGuest(managedWedding.id, { firstName: "Playwright", lastName: `GroomA-${token}`, side: "GROOM" })
      ).id;
      tableIdSSO = (
        await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 3, singleSideOnly: true })
      ).id;
      await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 1 });
      await weddingData.updateWedding(managedWedding.id, { sideMixing: "FULLY_MIXED" });
    });

    const body = await test.step("Act: generate a plan", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      return (await res.json()) as GenerateResponse;
    });

    await test.step("Assert: generation completes, the Groom is forced onto the Single-Side-Only table, and it's reported as a warning plus a score-report violation", async () => {
      expect(body.planVersion.isComplete).toBe(true);
      const groomTable = body.planVersion.assignments.find((a) => a.guestId === idGroom)?.tableId;
      expect(groomTable).toBe(tableIdSSO);
      expect(body.planVersion.warnings.length).toBe(1);
      expect(body.planVersion.warnings[0]).toContain("Single-Side-Only");
      expect(body.planVersion.warnings[0]).toContain("Table A");
      expect(body.scoreReport.sideMixing.singleSideOnlyViolations).toBe(1);
    });
  },
);
