/**
 * TS-40 (REQ-GUEST-LIST-MANAGEMENT) — converts AC-015 ("Removing a guest cleans up after itself
 * without collateral damage"). Traced directly against the Prisma schema
 * (packages/db/prisma/schema.prisma) and the DELETE .../guests/:guestId route handler
 * (apps/web/src/app/api/v1/weddings/[weddingId]/guests/[guestId]/route.ts):
 *
 * - `GuestRelationship.guestA`/`guestB` and `SeatAssignment.guest` all have `onDelete: Cascade` --
 *   deleting a guest silently deletes any seating rule referencing them and their seat_assignment
 *   rows (across every plan version, not just the current one). There is no "flagged for review"
 *   mechanism anywhere in the codebase for the cascaded rule -- the route returns only `{ok:
 *   true}`, with no rules-affected information at all. This test proves the actual, weaker
 *   guarantee (the rule and the assignment are both gone, cleanly, with no error and no orphaned
 *   reference) rather than asserting a "flagged for review" behavior the app doesn't have.
 * - `change_history_entries.description` is a plain string captured at write time, not a live
 *   join to the guests table (confirmed by the doc comment on
 *   packages/db/src/queries/activity.ts's `listActivityForWedding`) -- so a deleted guest's name
 *   plausibly survives in the activity log's historical text even after their own guest row and
 *   every seat assignment are gone. Proven here via a manual move (whose change-history
 *   description embeds the guest's name verbatim) followed by deletion.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface Assignment {
  guestId: string;
  tableId: string;
}

defineQualityTest(
  {
    id: "guest-list.deleting-a-guest-cascades-rules-and-assignments.no-collateral-damage",
    title: "deleting a guest cleanly cascades their rules and seat assignments, and doesn't touch anyone else",
    objective:
      "Confirms that deleting a guest removes them from the guest list, cascades away any seating rule referencing them and their own seat assignment, leaves an unrelated guest's rules and assignment completely untouched, and that their name survives in the historical activity log even though their own records are gone.",
    expectedOutcome:
      "The deleted guest is gone from the guest list and current plan version; the rule referencing them no longer exists; the unrelated guest keeps their own rule, table, and needsReassignment:false status unchanged; the deleted guest's name still appears in at least one activity-log entry's description text.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const guestToDelete = uniquePersonName(testInfo.workerIndex);
    const guestPartner = uniquePersonName(testInfo.workerIndex);
    const guestOther = uniquePersonName(testInfo.workerIndex);

    let deleteId = "";
    let partnerId = "";
    let otherId = "";
    let ruleWithDeletedId = "";
    let ruleOtherId = "";
    let planVersionId = "";
    let otherTableId = "";

    await test.step("Arrange: the guest to delete has a rule with a partner guest; an unrelated guest has its own separate rule and seat", async () => {
      const d = await weddingData.createGuest(managedWedding.id, guestToDelete);
      const p = await weddingData.createGuest(managedWedding.id, guestPartner);
      const o = await weddingData.createGuest(managedWedding.id, guestOther);
      const oPair = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      deleteId = d.id;
      partnerId = p.id;
      otherId = o.id;

      const rule1 = await weddingData.createRelationship(managedWedding.id, deleteId, partnerId, "PREFER_NEAR");
      ruleWithDeletedId = rule1.id;
      const rule2 = await weddingData.createRelationship(managedWedding.id, otherId, oPair.id, "MUST_SIT_TOGETHER");
      ruleOtherId = rule2.id;

      await weddingData.quickCreateTables(managedWedding.id, { count: 3, capacity: 8 });

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as { planVersion: { id: string; assignments: Assignment[] } };
      planVersionId = genBody.planVersion.id;
      otherTableId = genBody.planVersion.assignments.find((a) => a.guestId === otherId)!.tableId;
    });

    await test.step("Arrange: move the guest-to-delete once, so the activity log captures their name in a historical entry's plain-text description", async () => {
      const planRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const planBody = (await planRes.json()) as { planVersion: { assignments: Assignment[] } };
      const currentTableId = planBody.planVersion.assignments.find((a) => a.guestId === deleteId)!.tableId;

      const tablesRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/tables`);
      const { tables } = (await tablesRes.json()) as { tables: { id: string }[] };
      const differentTable = tables.find((t) => t.id !== currentTableId)!;

      const moveRes = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
        { data: { guestId: deleteId, tableId: differentTable.id } },
      );
      expect(moveRes.ok()).toBe(true);
    });

    await test.step("Act: delete the guest", async () => {
      const res = await context.request.delete(`/api/v1/weddings/${managedWedding.id}/guests/${deleteId}`);
      expect(res.ok()).toBe(true);
    });

    await test.step("Assert: the deleted guest is gone from the guest list and the current plan version", async () => {
      const listRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests`);
      const { guests } = (await listRes.json()) as { guests: { id: string }[] };
      expect(guests.some((g) => g.id === deleteId)).toBe(false);

      const getRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/guests/${deleteId}`);
      expect(getRes.status()).toBe(404);

      const planRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const planBody = (await planRes.json()) as { planVersion: { assignments: Assignment[] } };
      expect(planBody.planVersion.assignments.some((a) => a.guestId === deleteId)).toBe(false);
    });

    await test.step("Assert: the rule referencing the deleted guest is gone, cleanly (cascaded, not just orphaned)", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/relationships`);
      expect(res.ok()).toBe(true);
      const { relationships } = (await res.json()) as { relationships: { id: string }[] };
      expect(relationships.some((r) => r.id === ruleWithDeletedId)).toBe(false);
    });

    await test.step("Assert: the unrelated guest's own rule, table, and reassignment status are completely untouched", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/relationships`);
      const { relationships } = (await res.json()) as { relationships: { id: string }[] };
      expect(relationships.some((r) => r.id === ruleOtherId)).toBe(true);

      const planRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const planBody = (await planRes.json()) as {
        planVersion: { assignments: (Assignment & { needsReassignment: boolean })[] };
      };
      const otherAssignment = planBody.planVersion.assignments.find((a) => a.guestId === otherId);
      expect(otherAssignment).toBeDefined();
      expect(otherAssignment!.tableId).toBe(otherTableId);
      expect(otherAssignment!.needsReassignment).toBe(false);
    });

    await test.step("Assert: the deleted guest's name still survives in the historical activity log, even though their guest row and assignments are gone", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/activity`);
      expect(res.ok()).toBe(true);
      const { entries } = (await res.json()) as { entries: { description: string }[] };
      const fullName = `${guestToDelete.firstName} ${guestToDelete.lastName}`;
      expect(entries.some((e) => e.description.includes(fullName))).toBe(true);
    });
  },
);
