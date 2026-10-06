/**
 * TS-187 (REQ-AUTOMATED-SEAT-ASSIGNMENT, REQ-TABLE-VENUE-LAYOUT) — a table edit that was waiting
 * for the current plan while a Generate replaced it still re-checks the plan (reproduced before the
 * fix: once the Generate finished, the edit found "no current plan" -- the old one wasn't current
 * any more and the new one wasn't visible to it -- and saved without re-checking anything, so the
 * new plan kept saying "complete" with too many people at a table).
 *
 * The race is made exact from the test: the current plan version's row is held (holdPlanVersion)
 * so a Generate, and then a table edit, both wait for it in that order; then it's let go.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { holdPlanVersion } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "seat-assignment.a-change-waiting-on-generate-checks-the-new-plan.table-edit-after-generate",
    title: "a table edit that waited while Generate replaced the current plan re-checks the new plan, flagging who no longer fits",
    objective:
      "Confirms that when a Generate and then a table edit lowering the table's seats are both waiting for the current plan (held from the test), and the Generate goes first and replaces the plan, the table edit still finds the new current plan and re-checks it: the guest who no longer fits is flagged Needs Reassignment, the new plan is incomplete, and the edit's response warns about them.",
    expectedOutcome:
      "Generate: 201 with a new version, which is the current one. Table edit: 200 with one 'no longer fits at this table' warning. The new version has exactly one guest flagged Needs Reassignment and isComplete false.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT", "REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:tables", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const table = await weddingData.createTable(w, { label: "Table 1", capacity: 4 });
    for (let i = 0; i < 3; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const first = await weddingData.generatePlanVersion(w);
    expect(first.isComplete).toBe(true);

    let generating;
    let editing;
    await test.step("Generate, then a table edit, wait for the current plan; the Generate goes first", async () => {
      const held = await holdPlanVersion(first.id);
      try {
        generating = context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
        await held.waitForWaiters(1);
        editing = context.request.patch(`/api/v1/weddings/${w}/tables/${table.id}`, { data: { capacity: 2 } });
        await held.waitForWaiters(2);
      } finally {
        await held.release();
      }
    });

    await test.step("The table edit re-checked the new plan: one guest flagged, the plan incomplete", async () => {
      const [generated, edited] = await Promise.all([generating!, editing!]);
      expect(generated.status()).toBe(201);
      const newId = ((await generated.json()) as { planVersion: { id: string } }).planVersion.id;
      expect(newId).not.toBe(first.id);
      expect(edited.status()).toBe(200);
      const warnings = ((await edited.json()) as { warnings: string[] }).warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no longer fits at this table");

      const current = (await weddingData.listPlanVersions(w)).find((v) => v.isCurrent)!;
      expect(current.id).toBe(newId);
      const detail = await weddingData.getPlanVersionDetail(w, newId);
      expect(detail.assignments.filter((a) => a.needsReassignment)).toHaveLength(1);
      expect(detail.isComplete).toBe(false);
    });
  },
);
