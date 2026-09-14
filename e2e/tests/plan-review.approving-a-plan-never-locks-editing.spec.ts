/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS) — converts AC-051 ("Approving a plan does not prevent further
 * edits").
 *
 * Traced directly against every mutation path plan status could plausibly gate --
 * `moveGuestAssignment`, `unassignGuestFromPlan`, `setGuestAttendance`, `swapGuestAssignments` (all
 * in packages/db/src/queries/plan-versions.ts), plus guests.ts/tables.ts/relationships.ts entirely
 * -- and confirmed empirically against the real app: none of them check `status === "APPROVED"`
 * anywhere. The only two gates that exist anywhere in this codebase are Edit-level access and
 * "must be the Current version," both unrelated to approval status. A plan version being Approved
 * only ever changes what's *displayed* (the Modified Since Approval banner, FR-6.6/AC-052 --
 * covered in its own test) -- never what's *allowed*.
 *
 * This test proves the claim broadly rather than for one mutation type alone: a manual seat move,
 * a new guest being added, a table's capacity being edited, and a new seating rule being created
 * all succeed identically against an Approved plan version's wedding, and none of them are
 * rejected or silently ignored.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "plan-review.approving-a-plan-never-locks-editing.every-kind-of-edit-still-succeeds",
    title: "once a plan version is Approved, a manual seat move, adding a guest, editing a table, and creating a seating rule all still succeed",
    objective:
      "Confirms that approving a plan version never locks any assignment, guest, table, or rule -- a representative edit of each of those four kinds is attempted against the wedding after its Current Plan Version is Approved, and every one of them succeeds exactly as it would before approval.",
    expectedOutcome:
      "After approval: the manual seat move returns 200, the new guest is created (201), the table's capacity update succeeds, and the new seating rule is created -- none return an error, and the plan version remains APPROVED throughout.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let planVersionId = "";
    let guestAId = "";
    let guestBId = "";
    let tableAId = "";
    let tableBId = "";

    await test.step("Arrange: two guests, two tables, a generated plan version moved to In Review then Approved", async () => {
      const a = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      const b = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestAId = a.id;
      guestBId = b.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 2 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 2 });
      tableAId = tableA.id;
      tableBId = tableB.id;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;

      const toReview = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
      expect(toReview.status).toBe(200);
      const approved = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
      expect(approved.status).toBe(200);
      expect(approved.body.planVersion?.status).toBe("APPROVED");
    });

    await test.step("Act + Assert: a manual seat move still succeeds against the Approved plan", async () => {
      const currentTableOfA = (await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId)).assignments.find(
        (a) => a.guestId === guestAId,
      )?.tableId;
      const targetTableId = currentTableOfA === tableAId ? tableBId : tableAId;
      const move = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestAId, targetTableId);
      expect(move.status).toBe(200);
      expect(move.body.planVersion?.status).toBe("APPROVED");
    });

    await test.step("Act + Assert: adding a new guest still succeeds against the wedding, unaffected by the plan's Approved status", async () => {
      const newGuest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      expect(newGuest.id).toBeTruthy();
    });

    await test.step("Act + Assert: editing a table still succeeds", async () => {
      const updated = await weddingData.updateTable(managedWedding.id, tableAId, { capacity: 5 });
      expect(updated.capacity).toBe(5);
    });

    await test.step("Act + Assert: creating a new seating rule still succeeds", async () => {
      const rule = await weddingData.createRelationship(managedWedding.id, guestAId, guestBId, "PREFER_NEAR");
      expect(rule.id).toBeTruthy();
    });

    await test.step("Assert: the plan version is still APPROVED after all of the above -- nothing above changed its status", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      expect(detail.status).toBe("APPROVED");
    });
  },
);
