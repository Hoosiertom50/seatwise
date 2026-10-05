/**
 * TS-165 (REQ-CROSS-CUTTING-HARD-RULE-INVARIANT, REQ-PLAN-REVIEW-STATUS) — the seating plan's flags and completeness stay true after
 * every kind of change, not just the ones that seat someone.
 * - A guest added after the plan is complete makes it incomplete; approving is refused until
 *   they're seated.
 * - Moving a guest re-checks the table they left: a must-not-sit-together partner left behind is
 *   un-flagged.
 * - Marking a guest Not Attending re-checks their table: someone flagged for lack of room there
 *   is un-flagged once the seat is free.
 * - Unmarking a Restricted table drops its required-guest list, so those guests can be moved.
 * - A re-check that changes an approved plan shows "Modified since approval".
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import type { PlanVersionDetail } from "../data/api.js";

defineQualityTest(
  {
    id: "seating-plan.stays-accurate-after-every-change.add-move-attendance-restricted-approved",
    title: "plan flags and completeness stay accurate after adding a guest, moving away, freeing a seat, unmarking Restricted, and on an approved plan",
    objective:
      "Confirms that adding a guest to a complete plan makes it incomplete and approval is refused; that moving one of a flagged must-not-sit-together pair away un-flags the partner left behind; that marking a guest Not Attending at an over-full table un-flags the guest who didn't fit; that unmarking a Restricted table lets its required guest be moved elsewhere; and that lowering a table's seats on an approved plan shows Modified since approval.",
    expectedOutcome:
      "isComplete false after the add, approval refused mentioning unassigned guests. The partner's needsReassignment is false after the move. The overflow guest's needsReassignment is false after the attendance change. The move off the formerly Restricted table returns 200. modifiedSinceApproval.active is true after the capacity change on the approved plan.",
    requirementIds: ["REQ-CROSS-CUTTING-HARD-RULE-INVARIANT", "REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ weddingData }, testInfo) => {
    test.setTimeout(90_000);
    const newWedding = async (label: string) => (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, label))).id;
    const person = () => uniquePersonName(testInfo.workerIndex);
    const flagOf = (detail: PlanVersionDetail, guestId: string) =>
      detail.assignments.find((a) => a.guestId === guestId)?.needsReassignment;
    const approve = async (w: string, plan: PlanVersionDetail) => {
      const review = await weddingData.setPlanVersionStatus(w, plan.id, "IN_REVIEW");
      expect(review.status).toBe(200);
      return weddingData.setPlanVersionStatus(w, plan.id, "APPROVED");
    };

    await test.step("A guest added to a complete plan makes it incomplete, and approval is refused", async () => {
      const w = await newWedding("Added Guest");
      await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
      await weddingData.createGuest(w, person());
      const plan = await weddingData.generatePlanVersion(w);
      expect(plan.isComplete).toBe(true);
      await weddingData.createGuest(w, person());
      expect((await weddingData.getPlanVersionDetail(w, plan.id)).isComplete).toBe(false);
      const approved = await approve(w, plan);
      expect(approved.status).not.toBe(200);
      expect(approved.body.error).toContain("unassigned");
    });

    await test.step("Moving one of a flagged must-not-sit-together pair away un-flags the partner", async () => {
      const w = await newWedding("Moved Away");
      const t1 = await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
      const t2 = await weddingData.createTable(w, { label: "Table 2", capacity: 8 });
      const a = await weddingData.createGuest(w, person());
      const x = await weddingData.createGuest(w, person());
      const plan = await weddingData.generatePlanVersion(w);
      expect((await weddingData.moveGuestAssignment(w, plan.id, a.id, t1.id)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, plan.id, x.id, t1.id)).status).toBe(200);
      await weddingData.createRelationship(w, a.id, x.id, "MUST_NOT_SIT_TOGETHER");
      let detail = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(flagOf(detail, a.id)).toBe(true);
      expect(flagOf(detail, x.id)).toBe(true);
      expect((await weddingData.moveGuestAssignment(w, plan.id, a.id, t2.id)).status).toBe(200);
      detail = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(flagOf(detail, a.id)).toBe(false);
      expect(flagOf(detail, x.id)).toBe(false);
      expect(detail.isComplete).toBe(true);
    });

    await test.step("Marking a guest Not Attending frees room: the guest who didn't fit is un-flagged", async () => {
      const w = await newWedding("Freed Seat");
      const table = await weddingData.createTable(w, { label: "Table 1", capacity: 3 });
      for (let i = 0; i < 3; i++) await weddingData.createGuest(w, person());
      const plan = await weddingData.generatePlanVersion(w);
      await weddingData.updateTable(w, table.id, { capacity: 2 });
      let detail = await weddingData.getPlanVersionDetail(w, plan.id);
      const overflow = detail.assignments.filter((x) => x.needsReassignment);
      expect(overflow).toHaveLength(1);
      // Free a seat held by someone who does fit.
      const leaving = detail.assignments.find((x) => !x.needsReassignment && x.guestId !== overflow[0].guestId)!.guestId;
      expect((await weddingData.setAttendance(w, leaving, "NOT_ATTENDING")).status).toBe(200);
      detail = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(flagOf(detail, overflow[0].guestId)).toBe(false);
      expect(detail.isComplete).toBe(true);
    });

    await test.step("Unmarking a Restricted table drops its required list, so the guest can be moved", async () => {
      const w = await newWedding("Unrestricted");
      const restricted = await weddingData.createTable(w, { label: "Family", capacity: 4, isRestricted: true });
      const other = await weddingData.createTable(w, { label: "Table 2", capacity: 4 });
      const grandma = await weddingData.createGuest(w, person());
      await weddingData.setRequiredGuests(w, restricted.id, [grandma.id]);
      const plan = await weddingData.generatePlanVersion(w);
      expect((await weddingData.moveGuestAssignment(w, plan.id, grandma.id, other.id)).status).toBe(409);
      await weddingData.updateTable(w, restricted.id, { isRestricted: false });
      expect((await weddingData.moveGuestAssignment(w, plan.id, grandma.id, other.id)).status).toBe(200);
      const fresh = await weddingData.generatePlanVersion(w);
      expect(fresh.assignments.find((x) => x.guestId === grandma.id)).toBeTruthy();
    });

    await test.step("A re-check that changes an approved plan shows Modified since approval", async () => {
      const w = await newWedding("Approved Recheck");
      const table = await weddingData.createTable(w, { label: "Table 1", capacity: 2 });
      await weddingData.createGuest(w, person());
      await weddingData.createGuest(w, person());
      const plan = await weddingData.generatePlanVersion(w);
      expect((await approve(w, plan)).status).toBe(200);
      expect((await weddingData.getPlanVersionDetail(w, plan.id)).modifiedSinceApproval.active).toBe(false);
      await weddingData.updateTable(w, table.id, { capacity: 1 });
      const detail = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(detail.isComplete).toBe(false);
      expect(detail.modifiedSinceApproval.active).toBe(true);
    });
  },
);
