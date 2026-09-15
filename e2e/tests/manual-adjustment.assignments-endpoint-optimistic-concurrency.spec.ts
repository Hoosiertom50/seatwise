/**
 * TS-44 (REQ-MANUAL-ADJUSTMENT) — converts AC-059 ("A manual move is rejected if the plan changed
 * since the editor last loaded it").
 *
 * TS-43 already exercised this same `checkPlanVersionRevision` mechanism for the status-transition
 * and label-rename endpoints; this test exercises it specifically for the manual-move endpoint
 * (`POST .../plan-versions/:id/assignments`), which is what AC-059 is actually about. Traced
 * directly in packages/db/src/queries/plan-versions.ts: `checkPlanVersionRevision` locks the plan
 * version row (`FOR UPDATE`) inside the same transaction as the move, and compares its current
 * `revision` to the caller's `expectedRevision`; a mismatch throws `PlanVersionConflictError`,
 * which the route (apps/web/src/app/api/v1/weddings/[weddingId]/plan-versions/[planVersionId]/
 * assignments/route.ts) turns into a 409 carrying BOTH the error message and a fresh,
 * currently-committed `planVersion` -- confirmed empirically against the running app before
 * writing these assertions, including that a request that omits `expectedRevision` entirely skips
 * the check and always succeeds (which is exactly what undo/redo's own replay relies on -- see
 * manual-adjustment.undo-and-redo-a-manual-move.spec.ts's header comment on that asymmetry).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "manual-adjustment.assignments-endpoint-optimistic-concurrency.stale-expectedRevision-is-rejected-with-fresh-state",
    title: "a manual move sent with a stale expectedRevision is rejected (409) with the plan's current, fresh state attached, while the same move with the current revision succeeds",
    objective:
      "Confirms the manual seat-move endpoint enforces optimistic concurrency the same way every other plan-version write in this app does: a second manual move using a now-outdated expectedRevision (captured before an intervening first move already bumped the revision) is rejected with a 409 whose response body carries the plan's fresh, currently-committed state (not the stale one the caller sent), and that retrying with that fresh revision succeeds.",
    expectedOutcome:
      "The first move succeeds and increments the plan version's revision. A second move using the pre-first-move revision is rejected with 409 and a planVersion in the response body whose revision and assignments reflect the first move having already happened. Retrying the same move with that returned (current) revision succeeds.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    const token = testInfo.workerIndex;

    let planVersionId = "";
    let guestId = "";
    let tableAId = "";
    let tableBId = "";
    let staleRevision = 0;

    await test.step("Arrange: one guest, two single-seat tables, a Current plan version", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(token));
      guestId = guest.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Concurrency Table A", capacity: 1 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Concurrency Table B", capacity: 1 });
      tableAId = tableA.id;
      tableBId = tableB.id;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      staleRevision = generated.revision;
    });

    let currentTableId = "";
    let otherTableId = "";
    await test.step("Act: a first move succeeds and bumps the revision past what a second, stale caller last saw", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, planVersionId);
      currentTableId = detail.assignments.find((a) => a.guestId === guestId)!.tableId;
      otherTableId = currentTableId === tableAId ? tableBId : tableAId;

      const move = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestId, otherTableId, staleRevision);
      expect(move.status).toBe(200);
      expect(move.body.planVersion!.revision).toBe(staleRevision + 1);
    });

    await test.step("Act + Assert: a second move using the now-stale (pre-first-move) revision is rejected with 409 and the fresh state", async () => {
      const stale = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestId, currentTableId, staleRevision);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBeTruthy();
      expect(stale.body.planVersion!.revision).toBe(staleRevision + 1);
      // The fresh state reflects the first move having already happened -- NOT the stale
      // caller's own (rejected) intent.
      expect(stale.body.planVersion!.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(otherTableId);
    });

    await test.step("Act + Assert: retrying the same move with the current (fresh) revision succeeds", async () => {
      const freshRevision = staleRevision + 1;
      const retry = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestId, currentTableId, freshRevision);
      expect(retry.status).toBe(200);
      expect(retry.body.planVersion!.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(currentTableId);
      expect(retry.body.planVersion!.revision).toBe(freshRevision + 1);
    });
  },
);
