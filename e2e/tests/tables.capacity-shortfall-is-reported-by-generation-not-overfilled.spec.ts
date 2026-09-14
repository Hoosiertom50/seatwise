/**
 * TS-41 (REQ-TABLE-VENUE-LAYOUT) — converts AC-036 ("Table capacity is enforced in both manual
 * editing and generation"). The manual-editing half (a direct manual move to a full table is
 * blocked, 409, no assignment change) is already fully covered by TS-54's
 * hard-rules-block-every-direct-manual-move test -- not re-authored here to avoid duplicating
 * that coverage.
 *
 * This test covers the half that's specific to this story: what generation itself does when total
 * Attending headcount wedding-wide exceeds total table capacity. Traced directly against
 * `seating-engine.ts`'s `unassignedReason`/placement loop: generation never overfills a table to
 * make everyone fit -- it still returns 200 with a real plan version, but that version is
 * `isComplete: false`, the guest(s) who couldn't be seated are listed in `unassignedGuestIds`, and
 * a specific warning names them and the reason ("no table has enough remaining capacity"). The
 * AC's "produces no plan" is this: no *complete, usable* plan -- not literally no plan version
 * object, which is what the app actually returns and what the rest of the app (isComplete-gated
 * approval/export) already treats as blocking downstream, per the AC's own intent.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "tables.capacity-shortfall-is-reported-by-generation-not-overfilled.wedding-wide-shortfall",
    title: "generation reports a wedding-wide capacity shortfall instead of overfilling any table",
    objective:
      "Confirms that when total Attending headcount exceeds total table capacity wedding-wide, generation still returns a real plan version rather than failing outright, but that version is incomplete, names exactly the guest who couldn't be seated, gives the specific capacity-shortfall reason, and never assigns more guests to a table than its capacity allows.",
    expectedOutcome:
      "The plan version is isComplete: false, exactly one guest appears in unassignedGuestIds, a warning names them and cites 'no table has enough remaining capacity', and no table's assignment count exceeds its capacity.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const guestNameA = uniquePersonName(testInfo.workerIndex);
    const guestNameB = uniquePersonName(testInfo.workerIndex);
    const namesById = new Map<string, { firstName: string; lastName: string }>();
    let tableId = "";

    await test.step("Arrange: exactly one table seat, but two Attending guests -- either could be the one left unassigned, since nothing distinguishes them", async () => {
      const a = await weddingData.createGuest(managedWedding.id, guestNameA);
      const b = await weddingData.createGuest(managedWedding.id, guestNameB);
      namesById.set(a.id, guestNameA);
      namesById.set(b.id, guestNameB);
      const [table] = await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 1 });
      tableId = table.id;
    });

    const genBody = await test.step("Act: generate a plan", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      return (await res.json()) as {
        planVersion: {
          isComplete: boolean;
          unassignedGuestIds: string[];
          warnings: string[];
          assignments: { guestId: string; tableId: string }[];
        };
      };
    });

    await test.step("Assert: the plan is a real, saved, but incomplete plan version -- not a refusal", async () => {
      expect(genBody.planVersion.isComplete).toBe(false);
    });

    await test.step("Assert: exactly one guest is unassigned (whichever one didn't fit), with a specific capacity-shortfall reason naming them", async () => {
      expect(genBody.planVersion.unassignedGuestIds.length).toBe(1);
      const unassignedId = genBody.planVersion.unassignedGuestIds[0];
      const unassignedName = namesById.get(unassignedId)!;
      const warning = genBody.planVersion.warnings.find((w) => w.includes(unassignedName.firstName));
      expect(warning).toBeDefined();
      expect(warning).toContain("no table has enough remaining capacity");
    });

    await test.step("Assert: the one-seat table was never overfilled -- it holds at most its own capacity", async () => {
      const atTable = genBody.planVersion.assignments.filter((a) => a.tableId === tableId);
      expect(atTable.length).toBeLessThanOrEqual(1);
    });
  },
);
