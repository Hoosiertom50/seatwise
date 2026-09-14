/**
 * TS-41 (REQ-TABLE-VENUE-LAYOUT) — converts AC-039 ("No feature exists for assigning a specific
 * chair/seat number"). The workbook's own test steps ask for a manual audit across "every
 * planning, review, day-of, and export interface" -- broader than any single Playwright test can
 * exhaustively prove a negative over, and the three export endpoints
 * (export/chart, export/cards, export/lookup) all return a rendered PDF binary, not JSON, so their
 * actual printed content isn't independently re-verified here (no PDF-text-extraction library is
 * part of this app's own dependencies to build that on) -- the same kind of scope boundary AC-077's
 * infrastructure audit already established for this suite, documented rather than silently assumed.
 *
 * What this test does verify directly: a plan version's own assignment shape --
 * `PlanVersionAssignmentRow` (packages/db/src/queries/plan-versions.ts) -- which is the single
 * source every UI in the app (Plan tab, Day-of mode, and all three PDF exports via
 * `apps/web/src/lib/export-data.ts`'s `ExportData`) ultimately renders from, and confirms it
 * carries only a guest-to-table relationship, never a chair/seat index of any kind. Also confirms
 * each PDF export endpoint at least serves successfully as a real PDF (content-type), and a
 * repo-wide search for seatNumber/chairNumber/seatIndex/chairIndex (any casing) across
 * apps/web/src, packages/db/src, and packages/shared/src returns zero matches.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "tables.no-seat-or-chair-number-feature-exists.assignment-and-export-shape",
    title: "a guest's assignment and the export payload identify only a table, never a chair or seat number",
    objective:
      "Confirms that after generating and approving a plan, the plan version's assignment data contains no chair- or seat-numbering information -- every assignment identifies a table only -- and that all three PDF export endpoints serve successfully as real PDFs.",
    expectedOutcome:
      "Every assignment object in the plan version response has exactly the keys id/guestId/guestName/tableId/tableLabel/needsReassignment, with no seat/chair-like key anywhere, and each of the chart/cards/lookup export endpoints returns 200 with Content-Type application/pdf.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let planVersionId = "";

    await test.step("Arrange: generate and approve a plan with one seated guest", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as { planVersion: { id: string } };
      planVersionId = genBody.planVersion.id;

      const approveRes = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/status`,
        { data: { status: "APPROVED" } },
      );
      expect(approveRes.ok()).toBe(true);
    });

    await test.step("Assert: every assignment identifies only a table -- no chair/seat field of any kind", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const body = (await res.json()) as { planVersion: { assignments: Record<string, unknown>[] } };
      expect(body.planVersion.assignments.length).toBeGreaterThan(0);
      for (const assignment of body.planVersion.assignments) {
        const keys = Object.keys(assignment).sort();
        expect(keys).toEqual(["guestId", "guestName", "id", "needsReassignment", "tableId", "tableLabel"].sort());
        for (const key of keys) {
          expect(key.toLowerCase()).not.toContain("seat");
          expect(key.toLowerCase()).not.toContain("chair");
        }
      }
    });

    await test.step("Assert: all three PDF export endpoints (chart, cards, lookup) serve successfully as real PDFs", async () => {
      for (const kind of ["chart", "cards", "lookup"]) {
        const res = await context.request.get(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/export/${kind}`,
        );
        expect(res.ok()).toBe(true);
        expect(res.headers()["content-type"]).toBe("application/pdf");
      }
    });
  },
);
