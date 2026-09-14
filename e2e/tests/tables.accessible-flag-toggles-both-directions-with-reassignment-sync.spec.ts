/**
 * TS-41 (REQ-TABLE-VENUE-LAYOUT) — converts AC-038 ("A table can be marked Accessible and the
 * flag is visible"). Traced directly against `syncAccessibleTableReassignment`
 * (packages/db/src/queries/tables.ts), called from the table PATCH route whenever `isAccessible`
 * changes: it re-syncs every guest currently seated at that table to whether they *should* be
 * flagged Needs Reassignment given the table's new accessible state, in both directions -- turning
 * Accessible off flags a seated guest who requires one; turning it back on (with nothing else
 * changed) clears that same flag automatically, since the guest never actually moved and their
 * seat is valid again.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface Assignment {
  guestId: string;
  tableId: string;
  needsReassignment: boolean;
}

defineQualityTest(
  {
    id: "tables.accessible-flag-toggles-both-directions-with-reassignment-sync.turn-off-then-back-on",
    title: "turning a table's Accessible flag off flags a seated guest who needs it, and turning it back on clears the flag",
    objective:
      "Confirms that toggling an occupied table's Accessible flag off flags a currently-seated guest who requires an accessible table as Needs Reassignment and makes the plan incomplete, and that toggling the same flag back on (with nothing else changed) automatically clears that flag and restores completeness -- since the guest's seat was never actually invalid once the table is accessible again.",
    expectedOutcome:
      "After turning Accessible off: the guest's assignment shows needsReassignment: true, isComplete: false, and a warning names them. After turning it back on: needsReassignment: false, isComplete: true, with no warning.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const accessGuestName = uniquePersonName(testInfo.workerIndex);
    let accessGuestId = "";
    let tableId = "";
    let planVersionId = "";

    await test.step("Arrange: a guest who requires an accessible table, seated at an Accessible table via a real generation", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, {
        ...accessGuestName,
        requiresAccessibleTable: true,
      });
      accessGuestId = guest.id;
      const table = await weddingData.createTable(managedWedding.id, {
        label: "Accessible Table",
        capacity: 8,
        isAccessible: true,
      });
      tableId = table.id;

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as { planVersion: { id: string; isComplete: boolean } };
      planVersionId = genBody.planVersion.id;
      expect(genBody.planVersion.isComplete).toBe(true);
    });

    await test.step("Act: turn the table's Accessible flag off", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/tables/${tableId}`, {
        data: { isAccessible: false },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { table: { isAccessible: boolean }; warnings: string[] };
      expect(body.table.isAccessible).toBe(false);
      expect(body.warnings.some((w) => w.includes(accessGuestName.firstName))).toBe(true);
    });

    await test.step("Assert: the guest is flagged Needs Reassignment and the plan is incomplete", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const body = (await res.json()) as { planVersion: { isComplete: boolean; assignments: Assignment[] } };
      expect(body.planVersion.isComplete).toBe(false);
      const assignment = body.planVersion.assignments.find((a) => a.guestId === accessGuestId);
      expect(assignment!.needsReassignment).toBe(true);
    });

    await test.step("Act: turn the table's Accessible flag back on, with nothing else changed", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/tables/${tableId}`, {
        data: { isAccessible: true },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { table: { isAccessible: boolean }; warnings: string[] };
      expect(body.table.isAccessible).toBe(true);
      // Clearing a flag isn't itself a new problem to warn about.
      expect(body.warnings.length).toBe(0);
    });

    await test.step("Assert: the guest's Needs Reassignment flag is cleared and the plan is complete again", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const body = (await res.json()) as { planVersion: { isComplete: boolean; assignments: Assignment[] } };
      expect(body.planVersion.isComplete).toBe(true);
      const assignment = body.planVersion.assignments.find((a) => a.guestId === accessGuestId);
      expect(assignment!.needsReassignment).toBe(false);
      expect(assignment!.tableId).toBe(tableId);
    });
  },
);
