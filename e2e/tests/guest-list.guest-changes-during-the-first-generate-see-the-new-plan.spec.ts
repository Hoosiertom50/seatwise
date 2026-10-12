/**
 * TS-234 (REQ-GUEST-LIST-MANAGEMENT, REQ-AUTOMATED-SEAT-ASSIGNMENT) — TS-224 made table changes wait
 * for a wedding's very first Generate; guest edits, guest deletes and seating-rule removals still
 * didn't. With no plan yet they waited on nothing, so a party raised past its table's seats in that
 * moment left the new plan "complete" with the table over capacity and nobody flagged. Now they wait
 * on the wedding's lock -- the one Generate holds -- and then see the new plan.
 *
 * The race is made exact by holding the wedding's row lock from the test (holdWeddingLock): Generate
 * queues first, then the guest change queues behind it (waitForWaiters(2) only passes because the
 * change now waits too).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { holdWeddingLock } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "guest-list.guest-changes-during-the-first-generate-see-the-new-plan.edit-delete-and-rule-removal",
    title: "a guest edited or removed, or a seating rule removed, while the very first plan is being generated is checked against that new plan",
    objective:
      "Confirms that raising a seated party past its table's seats while the wedding's first Generate is running waits for it and flags the guest in the new plan; that removing a guest in that window waits and leaves the new plan without them and complete; and that removing a seating rule in that window waits for the new plan too.",
    expectedOutcome:
      "Each change queues behind Generate (two sessions wait on the wedding lock). Generate returns 201 every time. The headcount edit returns 200 and the guest is flagged Needs Reassignment with isComplete false; the guest delete succeeds, the plan has no seat for that guest and stays complete; the rule removal succeeds and the rule is gone.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:guests", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ weddingData, context }, testInfo) => {
    test.setTimeout(150_000);
    const person = () => uniquePersonName(testInfo.workerIndex);

    await test.step("A bigger party saved during the first Generate is flagged in the new plan", async () => {
      const w = (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "First Plan Party"))).id;
      await weddingData.createTable(w, { label: "T1", capacity: 4 });
      const guest = await weddingData.createGuest(w, { ...person(), headcount: 4 });
      const lock = await holdWeddingLock(w);
      let generating;
      let editing;
      try {
        generating = context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
        await lock.waitForWaiters(1);
        editing = context.request.patch(`/api/v1/weddings/${w}/guests/${guest.id}`, { data: { headcount: 6 } });
        await lock.waitForWaiters(2);
      } finally {
        await lock.release();
      }
      const [generated, edited] = await Promise.all([generating, editing]);
      expect(generated.status(), await generated.text()).toBe(201);
      expect(edited!.status(), await edited!.text()).toBe(200);
      const { planVersion } = (await generated.json()) as { planVersion: { id: string } };
      const detail = await weddingData.getPlanVersionDetail(w, planVersion.id);
      expect(detail.assignments.find((a) => a.guestId === guest.id)?.needsReassignment).toBe(true);
      expect(detail.isComplete).toBe(false);
    });

    await test.step("A guest removed during the first Generate is gone from the new plan, which stays complete", async () => {
      const w = (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "First Plan Delete"))).id;
      await weddingData.createTable(w, { label: "T1", capacity: 4 });
      const staying = await weddingData.createGuest(w, person());
      const leaving = await weddingData.createGuest(w, person());
      const lock = await holdWeddingLock(w);
      let generating;
      let deleting;
      try {
        generating = context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
        await lock.waitForWaiters(1);
        deleting = context.request.delete(`/api/v1/weddings/${w}/guests/${leaving.id}`);
        await lock.waitForWaiters(2);
      } finally {
        await lock.release();
      }
      const [generated, deleted] = await Promise.all([generating, deleting]);
      expect(generated.status(), await generated.text()).toBe(201);
      expect(deleted!.ok(), await deleted!.text()).toBe(true);
      const { planVersion } = (await generated.json()) as { planVersion: { id: string } };
      const detail = await weddingData.getPlanVersionDetail(w, planVersion.id);
      expect(detail.assignments.map((a) => a.guestId)).toEqual([staying.id]);
      expect(detail.unassignedGuestIds).toEqual([]);
      expect(detail.isComplete).toBe(true);
    });

    await test.step("A seating rule removed during the first Generate waits for the new plan", async () => {
      const w = (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "First Plan Rule"))).id;
      await weddingData.createTable(w, { label: "T1", capacity: 4 });
      const a = await weddingData.createGuest(w, person());
      const b = await weddingData.createGuest(w, person());
      const rule = await weddingData.createRelationship(w, a.id, b.id, "MUST_SIT_TOGETHER");
      const lock = await holdWeddingLock(w);
      let generating;
      let removing;
      try {
        generating = context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
        await lock.waitForWaiters(1);
        removing = context.request.delete(`/api/v1/weddings/${w}/relationships/${rule.id}`);
        await lock.waitForWaiters(2);
      } finally {
        await lock.release();
      }
      const [generated, removed] = await Promise.all([generating, removing]);
      expect(generated.status(), await generated.text()).toBe(201);
      expect(removed!.ok(), await removed!.text()).toBe(true);
      expect(await weddingData.listRelationships(w)).toEqual([]);
      const { planVersion } = (await generated.json()) as { planVersion: { id: string } };
      const detail = await weddingData.getPlanVersionDetail(w, planVersion.id);
      expect(detail.assignments.filter((s) => s.needsReassignment)).toEqual([]);
      expect(detail.isComplete).toBe(true);
    });
  },
);
