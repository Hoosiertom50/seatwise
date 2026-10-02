/**
 * TS-150 (REQ-CROSS-CUTTING-HARD-RULE-INVARIANT) — a plan can never quietly end up breaking a hard
 * rule after it was made. Each of these used to leave the plan "complete" (approvable) while it
 * broke a rule:
 * - editing a guest who was flagged because their table was over capacity cleared the flag;
 * - an import that raised a seated guest's headcount never re-checked the table;
 * - a new must-not-sit-together (or must-sit-together) rule didn't look at how people already sat;
 * - restoring an older version could put someone back at a Restricted table they're no longer on;
 * - regenerating kept a locked guest at a Restricted table they'd been taken off.
 * Also: a swap that fixes the last flagged guest makes the plan complete, and two Generate clicks
 * at once both succeed.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import type { PlanVersionDetail } from "../data/api.js";

defineQualityTest(
  {
    id: "seating-plan.hard-rules-stay-enforced-after-later-changes.capacity-import-rules-restore-lock-swap-race",
    title: "later guest edits, imports, new rules, restores and regenerations never leave an approvable plan that breaks a hard rule",
    objective:
      "Confirms that a capacity flag survives a guest edit and blocks approval; that an import raising a seated guest's headcount flags them; that a new must-not rule between tablemates (or a must-sit rule between guests at different tables) flags them and removing it clears the flag; that a swap seating the last flagged guest makes the plan complete; that restoring an older version doesn't put a guest back at a Restricted table they're off; that regenerating doesn't keep a locked guest at such a table; and that two simultaneous Generate requests both succeed.",
    expectedOutcome:
      "Each scenario's plan shows isComplete false with the expected guest flagged (and Approve refused), returning to complete when the cause is removed; the swap result is complete; the restored and regenerated plans don't seat the guest at the Restricted table; both parallel Generate calls return 201 with different version numbers.",
    requirementIds: ["REQ-CROSS-CUTTING-HARD-RULE-INVARIANT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ weddingData, context }, testInfo) => {
    test.setTimeout(120_000);
    const api = (path: string) => `/api/v1/weddings/${path}`;
    const current = async (w: string): Promise<PlanVersionDetail> => {
      const { planVersions: versions } = (await (await context.request.get(api(`${w}/plan-versions`))).json()) as {
        planVersions: { id: string; isCurrent: boolean }[];
      };
      const id = versions.find((v) => v.isCurrent)!.id;
      return ((await (await context.request.get(api(`${w}/plan-versions/${id}`))).json()) as { planVersion: PlanVersionDetail })
        .planVersion;
    };
    const flagged = (plan: PlanVersionDetail, guestId: string) =>
      plan.assignments.find((a) => a.guestId === guestId)?.needsReassignment;
    const tableOf = (plan: PlanVersionDetail, guestId: string) => plan.assignments.find((a) => a.guestId === guestId)?.tableId;
    const newWedding = (label: string) => weddingData.createWedding(uniqueTitle(testInfo.workerIndex, label));
    const guest = (w: string, extra: Record<string, unknown> = {}) =>
      weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), ...extra });

    await test.step("A capacity flag survives editing that guest, and the plan can't be approved", async () => {
      const w = (await newWedding("Capacity")).id;
      const table = await weddingData.createTable(w, { label: "T1", capacity: 4 });
      const guests = [await guest(w), await guest(w), await guest(w), await guest(w)];
      await weddingData.generatePlanVersion(w);
      await weddingData.updateTable(w, table.id, { capacity: 2 });
      let plan = await current(w);
      expect(plan.isComplete).toBe(false);
      const overflow = guests.filter((g) => flagged(plan, g.id));
      expect(overflow).toHaveLength(2);
      // Editing a flagged guest (side, tier, accessible flag all re-check their seat) keeps them flagged.
      await context.request.patch(api(`${w}/guests/${overflow[0].id}`), { data: { side: "GROOM" } });
      plan = await current(w);
      expect(flagged(plan, overflow[0].id)).toBe(true);
      expect(plan.isComplete).toBe(false);
      await weddingData.setPlanVersionStatus(w, plan.id, "IN_REVIEW");
      plan = await current(w);
      const approve = await context.request.post(api(`${w}/plan-versions/${plan.id}/status`), { data: { status: "APPROVED" } });
      expect(approve.status()).toBe(409);
    });

    await test.step("An import that raises a seated guest's headcount past the table's room flags them", async () => {
      const w = (await newWedding("Import")).id;
      await weddingData.createTable(w, { label: "T1", capacity: 4 });
      const g = await guest(w);
      await weddingData.generatePlanVersion(w);
      expect((await current(w)).isComplete).toBe(true);
      const commit = await context.request.post(api(`${w}/guests/import/commit`), {
        data: {
          csv: `guestId,firstName,lastName,headcount\n${g.id},${g.firstName},${g.lastName},6\n`,
          mapping: { guestId: "guestId", firstName: "firstName", lastName: "lastName", headcount: "headcount" },
        },
      });
      expect(commit.ok()).toBe(true);
      const plan = await current(w);
      expect(flagged(plan, g.id)).toBe(true);
      expect(plan.isComplete).toBe(false);
    });

    await test.step("A new must-not rule between tablemates flags them; removing the rule clears it", async () => {
      const w = (await newWedding("Must Not")).id;
      await weddingData.createTable(w, { label: "T1", capacity: 10 });
      const a = await guest(w);
      const b = await guest(w);
      await weddingData.generatePlanVersion(w);
      const res = await context.request.post(api(`${w}/relationships`), {
        data: { guestAId: a.id, guestBId: b.id, type: "MUST_NOT_SIT_TOGETHER" },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { relationship: { id: string }; warnings: string[] };
      expect(body.warnings.length).toBeGreaterThan(0);
      let plan = await current(w);
      expect(flagged(plan, a.id) || flagged(plan, b.id)).toBe(true);
      expect(plan.isComplete).toBe(false);

      expect((await context.request.delete(api(`${w}/relationships/${body.relationship.id}`))).status()).toBe(200);
      plan = await current(w);
      expect(flagged(plan, a.id)).toBe(false);
      expect(flagged(plan, b.id)).toBe(false);
      expect(plan.isComplete).toBe(true);
    });

    await test.step("A new must-sit rule between guests at different tables flags them", async () => {
      const w = (await newWedding("Must Sit")).id;
      const t1 = await weddingData.createTable(w, { label: "T1", capacity: 1 });
      await weddingData.createTable(w, { label: "T2", capacity: 1 });
      const a = await guest(w);
      const b = await guest(w);
      await weddingData.generatePlanVersion(w);
      expect(tableOf(await current(w), a.id)).not.toBe(tableOf(await current(w), b.id));
      expect(t1.id).toBeTruthy();
      await weddingData.createRelationship(w, a.id, b.id, "MUST_SIT_TOGETHER");
      const plan = await current(w);
      expect(flagged(plan, a.id) && flagged(plan, b.id)).toBe(true);
      expect(plan.isComplete).toBe(false);
    });

    await test.step("A swap that seats the last flagged guest makes the plan complete", async () => {
      const w = (await newWedding("Swap")).id;
      const plain = await weddingData.createTable(w, { label: "Plain", capacity: 1 });
      const accessible = await weddingData.createTable(w, { label: "Accessible", capacity: 1, isAccessible: true });
      const needs = await guest(w);
      const other = await guest(w);
      await weddingData.generatePlanVersion(w);
      let plan = await current(w);
      // Put the guest who'll need an accessible seat at the plain table, then mark their need.
      if (tableOf(plan, needs.id) !== plain.id) {
        const swapped = await weddingData.swapGuestAssignments(w, plan.id, needs.id, other.id, plan.revision);
        expect(swapped.status).toBe(200);
      }
      await context.request.patch(api(`${w}/guests/${needs.id}`), { data: { requiresAccessibleTable: true } });
      plan = await current(w);
      expect(flagged(plan, needs.id)).toBe(true);
      expect(plan.isComplete).toBe(false);
      const swap = await weddingData.swapGuestAssignments(w, plan.id, needs.id, other.id, plan.revision);
      expect(swap.status).toBe(200);
      plan = await current(w);
      expect(tableOf(plan, needs.id)).toBe(accessible.id);
      expect(plan.isComplete).toBe(true);
    });

    await test.step("Restore and regenerate never seat someone at a Restricted table they're not on", async () => {
      const w = (await newWedding("Restricted")).id;
      const head = await weddingData.createTable(w, { label: "Head", capacity: 2 });
      await weddingData.createTable(w, { label: "Other", capacity: 2 });
      const g = await guest(w, { isLocked: true });
      const listed = await guest(w);
      const v1 = await weddingData.generatePlanVersion(w);
      // Make sure g starts at Head in version 1.
      let plan = await current(w);
      if (tableOf(plan, g.id) !== head.id) {
        await context.request.post(api(`${w}/plan-versions/${plan.id}/assignments`), {
          data: { guestId: g.id, tableId: head.id, expectedRevision: plan.revision },
        });
      }
      const sourceId = (await current(w)).id;
      expect(v1.id).toBeTruthy();
      // Head becomes Restricted, for "listed" only.
      await weddingData.updateTable(w, head.id, { isRestricted: true });
      await weddingData.setRequiredGuests(w, head.id, [listed.id]);

      const restored = await weddingData.restoreVersion(w, sourceId);
      expect(restored.status).toBe(201);
      plan = await current(w);
      expect(tableOf(plan, g.id)).not.toBe(head.id);

      await weddingData.generatePlanVersion(w);
      plan = await current(w);
      expect(tableOf(plan, g.id)).not.toBe(head.id);
      expect(tableOf(plan, listed.id)).toBe(head.id);
    });

    await test.step("Two Generate requests at once both succeed", async () => {
      const w = (await newWedding("Race")).id;
      await weddingData.createTable(w, { label: "T1", capacity: 4 });
      await guest(w);
      const [one, two] = await Promise.all([
        context.request.post(api(`${w}/plan-versions/generate`)),
        context.request.post(api(`${w}/plan-versions/generate`)),
      ]);
      expect(one.status()).toBe(201);
      expect(two.status()).toBe(201);
      const n1 = ((await one.json()) as { planVersion: { versionNumber: number } }).planVersion.versionNumber;
      const n2 = ((await two.json()) as { planVersion: { versionNumber: number } }).planVersion.versionNumber;
      expect(new Set([n1, n2]).size).toBe(2);
    });
  },
);
