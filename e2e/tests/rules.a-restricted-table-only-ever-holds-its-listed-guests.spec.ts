/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-031 ("A Restricted table only ever holds
 * its explicitly listed guests").
 *
 * The manual-editing halves of this AC -- removing a required guest from their Restricted table
 * is blocked, and adding an unlisted guest to one is blocked -- are already fully covered by
 * TS-54's cross-cutting-invariant.hard-rules-block-every-direct-manual-move.spec.ts. Not
 * re-authored here.
 *
 * What's new: whether *generation itself* (not just a manual move) correctly seats every required
 * guest at their Restricted table and never an unlisted guest there (traced against
 * seating-engine.ts's pinned-unit placement -- a required guest's unit is pinned directly to the
 * table, bypassing the general candidate pool that always excludes Restricted tables for everyone
 * else); the "second Restricted table" and "over-capacity list" save-time validations
 * (`setRequiredGuestsForTable` in packages/db/src/queries/tables.ts); and what happens when a
 * required guest becomes Not Attending.
 *
 * One sub-clause is not implemented and not tested around here: "a required list ... conflicting
 * with another hard rule cannot be saved." Read directly against `setRequiredGuestsForTable` --
 * it validates capacity and single-Restricted-table membership, but never checks whether the
 * guests being required have a MUST_NOT_SIT_TOGETHER rule between them, or whether the table is
 * Accessible for a guest who requires one. That's a real gap against this AC's literal wording.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "rules.a-restricted-table-only-ever-holds-its-listed-guests.generation-and-save-time-validation",
    title: "generation seats only the required guests at a Restricted table, and its required-guest list validates capacity, single-table membership, and a Not-Attending guest's continued membership",
    objective:
      "Confirms generation itself places both required guests at their Restricted table and never an unlisted Attending guest, that a guest already required at one Restricted table can't be required at a second, that a required list exceeding the table's capacity can't be saved, and that a required guest who becomes Not Attending occupies no capacity but stays on the required list until an editor removes them.",
    expectedOutcome:
      "Generation seats both required guests at the Restricted table and the unlisted guest elsewhere, complete. A second-Restricted-table attempt and an over-capacity list attempt both return 409. After the required guest becomes Not Attending, they still appear in the table's requiredGuestIds, have no seat assignment, and the other required guest keeps their seat with the plan still complete.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:tables", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let idA = "";
    let idB = "";
    let idC = "";
    let restrictedTableId = "";
    let otherTableId = "";

    await test.step("Arrange: a Restricted table requiring Guests A and B (both Attending), an unlisted Attending Guest C, and a plain table for C", async () => {
      idA = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idB = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      idC = (await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex))).id;
      restrictedTableId = (
        await weddingData.createTable(managedWedding.id, { label: "VIP Table", capacity: 2, isRestricted: true })
      ).id;
      otherTableId = (await weddingData.createTable(managedWedding.id, { label: "Other Table", capacity: 1 })).id;
      await weddingData.setRequiredGuests(managedWedding.id, restrictedTableId, [idA, idB]);
    });

    await test.step("Act + Assert: generation seats A and B at the Restricted table and C at the other table, complete", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        planVersion: { isComplete: boolean; assignments: { guestId: string; tableId: string }[] };
      };
      expect(body.planVersion.isComplete).toBe(true);
      const tableOf = (id: string) => body.planVersion.assignments.find((a) => a.guestId === id)?.tableId;
      expect(tableOf(idA)).toBe(restrictedTableId);
      expect(tableOf(idB)).toBe(restrictedTableId);
      expect(tableOf(idC)).toBe(otherTableId);
    });

    await test.step("Assert: a guest already required at one Restricted table can't be required at a second", async () => {
      const secondRestrictedId = (
        await weddingData.createTable(managedWedding.id, { label: "Second Restricted", capacity: 2, isRestricted: true })
      ).id;
      const res = await context.request.put(
        `/api/v1/weddings/${managedWedding.id}/tables/${secondRestrictedId}/required-guests`,
        { data: { guestIds: [idA] } },
      );
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(`already required at "VIP Table"`);
    });

    await test.step("Assert: a required list whose total headcount exceeds the table's capacity can't be saved", async () => {
      const res = await context.request.put(
        `/api/v1/weddings/${managedWedding.id}/tables/${restrictedTableId}/required-guests`,
        { data: { guestIds: [idA, idB, idC] } },
      );
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("only has 2");
    });

    await test.step("Act: Guest B becomes Not Attending", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/guests/${idB}`, {
        data: { dayOfAttendance: "NOT_ATTENDING" },
      });
      expect(res.ok()).toBe(true);
    });

    await test.step("Assert: B stays on the Restricted table's required-guest list, but occupies no seat -- A keeps theirs, and the plan is still complete", async () => {
      const tablesRes = await context.request.get(`/api/v1/weddings/${managedWedding.id}/tables`);
      const { tables } = (await tablesRes.json()) as { tables: { id: string; requiredGuestIds: string[] }[] };
      const restrictedTable = tables.find((t) => t.id === restrictedTableId)!;
      expect(restrictedTable.requiredGuestIds.sort()).toEqual([idA, idB].sort());

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as {
        planVersion: { isComplete: boolean; assignments: { guestId: string; tableId: string }[] };
      };
      expect(genBody.planVersion.isComplete).toBe(true);
      expect(genBody.planVersion.assignments.some((a) => a.guestId === idB)).toBe(false);
      const tableOfA = genBody.planVersion.assignments.find((a) => a.guestId === idA)?.tableId;
      expect(tableOfA).toBe(restrictedTableId);
    });
  },
);
