/**
 * TS-54 (REQ-CROSS-CUTTING-HARD-RULE-INVARIANT) — converts AC-002 ("Indirect hard-rule violation
 * flags the guest instead of hiding it"). Editing a guest's Requires Accessible Table (or Side,
 * Relationship Tier, or household) from the Guests tab is the one place a hard-rule violation can
 * appear *without* anyone touching the seating plan directly -- the guest's own already-saved
 * seat becomes invalid out from under them. The workbook's expectation is specific: the guest is
 * flagged Needs Reassignment (not silently re-seated, and not left looking validly assigned), the
 * plan is visibly incomplete, nothing else moves, and both approval and event-ready export are
 * blocked until it's fixed.
 *
 * Traced directly to apps/web/src/app/api/v1/weddings/[weddingId]/guests/[guestId]/route.ts's
 * `PATCH`: editing any of `REASSIGNMENT_TRIGGER_FIELDS` (side, tier, partyName,
 * requiresAccessibleTable) calls `revalidateGuestAssignment`, which re-checks the guest's current
 * seat against hard rules and sets that one seat_assignment's `needsReassignment` -- read from
 * packages/db/src/queries/plan-versions.ts.
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
    id: "cross-cutting-invariant.guest-edit-flags-instead-of-hiding-violation.requires-accessible-table",
    title: "editing a guest's Requires Accessible Table flags them Needs Reassignment instead of hiding the conflict",
    objective:
      "Confirms that changing an already-seated guest's Requires Accessible Table from No to Yes -- with no change to the seating plan itself -- flags that guest Needs Reassignment, makes the plan incomplete, moves no one else, and blocks both approval and event-ready export until fixed.",
    expectedOutcome:
      "The guest's own assignment is marked needsReassignment, the plan's isComplete flips to false, the unrelated guest's assignment is untouched, and both the Approve and export actions are refused (never silently allowed) while the flag stands.",
    requirementIds: ["REQ-CROSS-CUTTING-HARD-RULE-INVARIANT"],
    tags: ["@mutating", "@feature:guests", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const guestA = uniquePersonName(testInfo.workerIndex);
    const guestOther = uniquePersonName(testInfo.workerIndex);

    let planVersionId = "";
    let guestAId = "";
    let otherTableId = "";

    await test.step("Arrange: Guest A (Requires Accessible Table = No) and an unrelated guest, both seated at a non-accessible table via a real generation", async () => {
      const a = await weddingData.createGuest(managedWedding.id, guestA);
      const other = await weddingData.createGuest(managedWedding.id, guestOther);
      guestAId = a.id;
      await weddingData.createTable(managedWedding.id, { label: "Table 5", capacity: 8, isAccessible: false });

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as {
        planVersion: { id: string; isComplete: boolean; assignments: Assignment[] };
      };
      planVersionId = genBody.planVersion.id;
      expect(genBody.planVersion.isComplete).toBe(true);
      otherTableId = genBody.planVersion.assignments.find((x) => x.guestId === other.id)!.tableId;
    });

    await test.step("Act: edit Guest A, changing Requires Accessible Table from No to Yes", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/guests/${guestAId}`, {
        data: { requiresAccessibleTable: true },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings.some((w) => w.includes("Needs Reassignment"))).toBe(true);
    });

    await test.step("Assert: Guest A is flagged Needs Reassignment, the plan is incomplete, and the unrelated guest didn't move", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { planVersion: { isComplete: boolean; assignments: Assignment[] } };
      expect(body.planVersion.isComplete).toBe(false);

      const aAssignment = body.planVersion.assignments.find((x) => x.guestId === guestAId);
      expect(aAssignment).toBeDefined();
      expect(aAssignment!.needsReassignment).toBe(true);

      const otherAssignment = body.planVersion.assignments.find((x) => x.guestId !== guestAId);
      expect(otherAssignment!.tableId).toBe(otherTableId);
      expect(otherAssignment!.needsReassignment).toBe(false);
    });

    await test.step("Assert: approving the plan is refused while Guest A is unresolved", async () => {
      const res = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/status`,
        { data: { status: "APPROVED" } },
      );
      expect(res.status()).toBe(409);
    });

    await test.step("Assert: event-ready export is refused while the plan isn't Approved", async () => {
      const res = await context.request.get(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/export/chart`,
      );
      expect(res.status()).toBe(409);
    });
  },
);
