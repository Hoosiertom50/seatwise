/**
 * TS-250 (review 11) -- a guest flagged "Needs reassignment" on a plan that's still Approved (a
 * party grew after approval, so their table is now over capacity) is not presented as validly
 * seated:
 * - the Seating plan tab's Export box warns that guests need a new seat and are listed under
 *   "Needs reassignment" on the PDFs (what the PDFs print is checked by the unit tests in
 *   apps/web/src/lib/pdf-needs-reassignment-text.test.mts -- the served PDFs use an embedded font
 *   whose text can't be read back here);
 * - the PDFs still export;
 * - the Day-of tab reads "Needs reassignment (at {table})" for that guest, not "Seated at {table}".
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "cross-cutting.guests-needing-a-new-seat-are-not-shown-as-seated.export-warns-and-day-of-says-so",
    title: "A guest whose party grew after approval is flagged on Export and on Day-of, not shown as seated",
    objective:
      "Approves a complete plan with one 2-seat table and two single guests, then changes one guest's party size from 1 to 2 through the API (as the Guests tab would). Confirms the plan is still Approved with exactly one guest flagged 'Needs reassignment', the Seating plan tab's Export box shows the 'needs a new seat' warning, the lookup-list PDF still exports, and the Day-of tab shows that guest as 'Needs reassignment (at {table})' and the other guest as 'Seated at {table}'.",
    expectedOutcome:
      "GET plan version: status APPROVED, exactly one assignment with needsReassignment true. The warning (data-testid export-needs-reassignment-warning) starts '1 guest needs a new seat' and mentions \"Needs reassignment\". GET export/lookup returns 200 application/pdf starting '%PDF-'. On Day-of the flagged guest's status line reads exactly 'Needs reassignment (at <table>)' and the other guest's reads 'Seated at <table>'.",
    requirementIds: ["REQ-EXPORT-PRINT-RESTORE"],
    tags: ["@mutating", "@feature:export", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    const w = managedWedding.id;
    let planVersionId = "";
    let flaggedName = "";
    let otherName = "";
    let tableLabel = "";

    await test.step("Arrange: an approved, complete plan -- one 2-seat table, two guests of one", async () => {
      const first = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      await weddingData.quickCreateTables(w, { count: 1, capacity: 2 });
      const plan = await weddingData.generatePlanVersion(w);
      planVersionId = plan.id;
      expect(plan.isComplete).toBe(true);
      expect((await weddingData.setPlanVersionStatus(w, plan.id, "APPROVED")).status).toBe(200);

      // The first guest's party grows from 1 to 2 -- the table now needs 3 seats.
      const grown = await context.request.patch(`/api/v1/weddings/${w}/guests/${first.id}`, { data: { headcount: 2 } });
      expect(grown.status()).toBe(200);

      const after = await weddingData.getPlanVersionDetail(w, planVersionId);
      expect(after.status).toBe("APPROVED");
      const flagged = after.assignments.filter((a) => a.needsReassignment);
      expect(flagged).toHaveLength(1);
      // The Day-of row shows a party of two as "Name (+1)".
      const shown = (a: { guestId: string; guestName: string }) => (a.guestId === first.id ? `${a.guestName} (+1)` : a.guestName);
      flaggedName = shown(flagged[0]);
      tableLabel = flagged[0].tableLabel;
      otherName = shown(after.assignments.find((a) => !a.needsReassignment)!);
    });

    await test.step("The Export box warns that a guest needs a new seat, and the PDFs still export", async () => {
      const plan = new PlanTabPage(page);
      await plan.goto(w);
      const warning = plan.exportNeedsReassignmentWarning();
      await expect(warning).toContainText("1 guest needs a new seat");
      await expect(warning).toContainText('"Needs reassignment"');
      const res = await context.request.get(`/api/v1/weddings/${w}/plan-versions/${planVersionId}/export/lookup?tz=America/New_York`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("application/pdf");
      expect((await res.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });

    await test.step("Day-of says the flagged guest needs reassignment, not that they're seated", async () => {
      const dayOf = new DayOfTabPage(page);
      await dayOf.goto(w);
      await expect(dayOf.guestStatusText(flaggedName)).toHaveText(`Needs reassignment (at ${tableLabel})`);
      await expect(dayOf.guestStatusText(otherName)).toHaveText(`Seated at ${tableLabel}`);
      // Searching for the guest shows the same.
      await dayOf.search(flaggedName.replace(" (+1)", ""));
      await expect(dayOf.guestStatusText(flaggedName)).toHaveText(`Needs reassignment (at ${tableLabel})`);
    });
  }
);
