/**
 * TS-224 (REQ-TABLE-VENUE-LAYOUT, REQ-AUTOMATED-SEAT-ASSIGNMENT) — a table removed or edited while
 * a wedding's very first plan is being generated. Before, these changes only waited on the current
 * plan's row, and before the first plan there is none: a removal counted 0 seated guests and
 * deleted the table under the new plan (leaving it "complete" with guests silently unseated), and an
 * edit left the new plan unchecked. Now, with no plan yet, they wait on the wedding's lock -- the one
 * Generate holds -- and then see the new plan.
 *
 * The race is made exact by holding the wedding's row lock from the test (holdWeddingLock): Generate
 * queues first, then the table change queues behind it.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { holdWeddingLock } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "tables.a-table-changed-during-the-first-generate-sees-the-new-plan.remove-and-edit",
    title: "a table removed or edited while the very first plan is being generated is checked against that new plan",
    objective:
      "Confirms that removing a table while the wedding's first Generate is running waits for it, then asks for confirmation with the new plan's seated count, and that confirming leaves the plan incomplete with those guests unassigned; and that lowering a table's seats in the same window flags the extra guest in the new plan.",
    expectedOutcome:
      "The unconfirmed removal returns 409 with seatedCount 2 and the table stays; the confirmed removal returns 200, the plan is incomplete and both guests are unassigned. The seat edit returns 200 and one of the two guests is flagged Needs Reassignment, with isComplete false.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT", "REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:tables", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    test.setTimeout(120_000);
    const person = () => uniquePersonName(testInfo.workerIndex);

    await test.step("A removal started during the first Generate sees the new plan, asks first and recounts", async () => {
      const w = managedWedding.id;
      const table = await weddingData.createTable(w, { label: "T2", capacity: 4 });
      const guests = [await weddingData.createGuest(w, person()), await weddingData.createGuest(w, person())];
      const lock = await holdWeddingLock(w);
      let generating;
      let removing;
      try {
        generating = context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
        await lock.waitForWaiters(1);
        removing = context.request.delete(`/api/v1/weddings/${w}/tables/${table.id}`);
        await lock.waitForWaiters(2);
      } finally {
        await lock.release();
      }
      const [generated, removed] = await Promise.all([generating, removing]);
      expect(generated.status()).toBe(201);
      const { planVersion } = (await generated.json()) as { planVersion: { id: string } };
      expect(removed!.status()).toBe(409);
      expect(await removed!.json()).toMatchObject({ needsConfirmation: true, seatedCount: 2 });
      expect((await weddingData.listTables(w)).some((t) => t.id === table.id)).toBe(true);

      const confirmed = await context.request.delete(`/api/v1/weddings/${w}/tables/${table.id}?confirm=true&seatedCount=2`);
      expect(confirmed.status()).toBe(200);
      const detail = await weddingData.getPlanVersionDetail(w, planVersion.id);
      expect(detail.isComplete).toBe(false);
      expect([...detail.unassignedGuestIds].sort()).toEqual(guests.map((g) => g.id).sort());
    });

    await test.step("A seat edit started during the first Generate is checked in the new plan", async () => {
      const w = (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "First Plan Edit"))).id;
      const table = await weddingData.createTable(w, { label: "T2", capacity: 4 });
      await weddingData.createGuest(w, person());
      await weddingData.createGuest(w, person());
      const lock = await holdWeddingLock(w);
      let generating;
      let editing;
      try {
        generating = context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
        await lock.waitForWaiters(1);
        editing = context.request.patch(`/api/v1/weddings/${w}/tables/${table.id}`, { data: { capacity: 1 } });
        await lock.waitForWaiters(2);
      } finally {
        await lock.release();
      }
      const [generated, edited] = await Promise.all([generating, editing]);
      expect(generated.status()).toBe(201);
      expect(edited!.status()).toBe(200);
      const { planVersion } = (await generated.json()) as { planVersion: { id: string } };
      const detail = await weddingData.getPlanVersionDetail(w, planVersion.id);
      expect(detail.assignments.filter((a) => a.needsReassignment)).toHaveLength(1);
      expect(detail.isComplete).toBe(false);
    });
  },
);
