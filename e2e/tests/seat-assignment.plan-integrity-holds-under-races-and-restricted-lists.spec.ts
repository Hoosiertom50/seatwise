/**
 * TS-173 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — seating plan integrity, round 3.
 * - A table edited while Generate is working is checked in the new version (it used to save every
 *   seat unflagged, so a plan could be overfilled and still "complete").
 * - A guest put on a Restricted table's list while seated somewhere else is flagged (only the other
 *   way round used to be), a Restricted table can't have fewer seats than its list needs, and two
 *   guests can't be required to sit together when only one is on a list.
 * - A guest who declines while a Restore is on its way never ends up seated by it.
 * - A guest declining while the planner moves someone into their table: both go through, no error.
 *
 * The races are made exact by holding the wedding's row lock from the test (holdWeddingLock), so a
 * request is paused at the point the race used to slip in.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueTitle } from "../data/ids.js";
import { holdWeddingLock } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "seat-assignment.plan-integrity-holds-under-races-and-restricted-lists.generate-restricted-restore-decline",
    title: "Generate checks what it saves, required guests are flagged wherever they sit, Restore never seats a guest who just declined, and a decline during a move never fails",
    objective:
      "Confirms that lowering a table's seats while Generate is paused leaves the new version with the extra guests flagged and incomplete; that putting a seated guest on another table's required list flags them, that seats below the list's need are refused, and that a must-sit-together rule between a listed and an unlisted guest is refused; that a guest declining while a Restore is paused has no seat in the restored version; and that declines and moves into the same table at the same moment all succeed.",
    expectedOutcome:
      "Two of four guests flagged and isComplete false after the paused Generate. The listed guest is flagged (with a warning), the 1-seat edit gets 422, the rule gets 409. The declined guest isn't in the restored version's assignments. Every decline and move returns 200.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:tables", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, playwright }, testInfo) => {
    test.setTimeout(120_000);
    const person = () => uniquePersonName(testInfo.workerIndex);
    const newWedding = async (label: string) => (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, label))).id;
    const visitor = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() },
    });
    const rsvpToken = async (weddingId: string, guestId: string) => {
      const res = await context.request.post(`/api/v1/weddings/${weddingId}/guests/${guestId}/rsvp-link`, { data: {} });
      return ((await res.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
    };
    const decline = (token: string) => visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "DECLINED", headcount: 1, plusOneNames: null } });

    try {
      await test.step("A table edited while Generate is working is checked in the new version", async () => {
        const w = managedWedding.id;
        const table = await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
        for (let i = 0; i < 4; i++) await weddingData.createGuest(w, person());
        const lock = await holdWeddingLock(w);
        let generating;
        let editing;
        try {
          generating = context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
          await lock.waitForWaiters(1);
          // TS-224: before the first plan exists, a table edit waits for the wedding lock too, so
          // it queues behind Generate (it used to slip past and miss the plan being made).
          editing = weddingData.updateTable(w, table.id, { capacity: 2 });
          await lock.waitForWaiters(2);
        } finally {
          await lock.release();
        }
        const res = await generating;
        await editing;
        expect(res.status()).toBe(201);
        const { planVersion } = (await res.json()) as { planVersion: { id: string } };
        const detail = await weddingData.getPlanVersionDetail(w, planVersion.id);
        expect(detail.assignments.filter((a) => a.needsReassignment)).toHaveLength(2);
        expect(detail.isComplete).toBe(false);
      });

      await test.step("Restricted lists: seated elsewhere is flagged, seats can't drop below the list, rules must match", async () => {
        const w = await newWedding("Restricted Lists");
        await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
        const vip = await weddingData.createTable(w, { label: "VIP", capacity: 4, isRestricted: true });
        const listedName = person();
        const listed = await weddingData.createGuest(w, listedName);
        const second = await weddingData.createGuest(w, person());
        const unlisted = await weddingData.createGuest(w, person());
        const plan = await weddingData.generatePlanVersion(w);
        expect(plan.assignments.find((a) => a.guestId === listed.id)?.tableId).not.toBe(vip.id);

        const put = await context.request.put(`/api/v1/weddings/${w}/tables/${vip.id}/required-guests`, {
          data: { guestIds: [listed.id, second.id] },
        });
        expect(put.status()).toBe(200);
        expect(((await put.json()) as { warnings: string[] }).warnings.join("\n")).toContain(listedName.firstName);
        const detail = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(detail.assignments.find((a) => a.guestId === listed.id)?.needsReassignment).toBe(true);
        expect(detail.isComplete).toBe(false);

        const shrink = await context.request.patch(`/api/v1/weddings/${w}/tables/${vip.id}`, { data: { capacity: 1 } });
        expect(shrink.status()).toBe(422);
        expect(((await shrink.json()) as { error: string }).error).toContain("can't have fewer");

        const rule = await context.request.post(`/api/v1/weddings/${w}/relationships`, {
          data: { guestAId: listed.id, guestBId: unlisted.id, type: "MUST_SIT_TOGETHER" },
        });
        expect(rule.status()).toBe(409);
        expect(((await rule.json()) as { error: string }).error).toContain("isn't on its list");
      });

      await test.step("A guest who declines while a Restore is on its way isn't seated by it", async () => {
        const w = await newWedding("Restore Decline");
        await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
        const decliner = await weddingData.createGuest(w, person());
        await weddingData.createGuest(w, person());
        const first = await weddingData.generatePlanVersion(w);
        await weddingData.generatePlanVersion(w);
        const token = await rsvpToken(w, decliner.id);
        const lock = await holdWeddingLock(w);
        let restoring;
        let declining;
        try {
          restoring = context.request.post(`/api/v1/weddings/${w}/plan-versions/${first.id}/restore`);
          await lock.waitForWaiters(1);
          declining = decline(token);
          await lock.waitForWaiters(2);
        } finally {
          await lock.release();
        }
        const [restored, declined] = await Promise.all([restoring, declining]);
        expect(restored.status()).toBe(201);
        expect(declined!.status()).toBe(200);
        const current = (await weddingData.listPlanVersions(w)).find((v) => v.isCurrent)!;
        const detail = await weddingData.getPlanVersionDetail(w, current.id);
        expect(detail.assignments.map((a) => a.guestId)).not.toContain(decliner.id);
      });

      await test.step("Declines and moves into the same table at the same moment all go through", async () => {
        const w = await newWedding("Decline And Move");
        const t1 = await weddingData.createTable(w, { label: "Table 1", capacity: 10 });
        const t2 = await weddingData.createTable(w, { label: "Table 2", capacity: 10 });
        const pairs: { mover: string; decliner: string; token: string }[] = [];
        for (let i = 0; i < 3; i++) {
          const mover = await weddingData.createGuest(w, person());
          const decliner = await weddingData.createGuest(w, person());
          pairs.push({ mover: mover.id, decliner: decliner.id, token: await rsvpToken(w, decliner.id) });
        }
        const plan = await weddingData.generatePlanVersion(w);
        const tableOf = (guestId: string) => plan.assignments.find((a) => a.guestId === guestId)!.tableId;
        const results = await Promise.all(
          pairs.flatMap(({ mover, decliner, token }) => {
            // Into the decliner's table, or out of it if they already share one.
            const target = tableOf(mover) === tableOf(decliner) ? (tableOf(mover) === t1.id ? t2.id : t1.id) : tableOf(decliner);
            return [weddingData.moveGuestAssignment(w, plan.id, mover, target).then((r) => r.status), decline(token).then((r) => r.status())];
          })
        );
        expect(results).toEqual(results.map(() => 200));
      });
    } finally {
      await visitor.dispose();
    }
  },
);
