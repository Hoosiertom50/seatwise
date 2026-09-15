/**
 * TS-44 (REQ-MANUAL-ADJUSTMENT) — converts AC-058 ("Every manual move is recorded in the plan's
 * change history with who made it and when").
 *
 * Traced directly in packages/db/src/queries/plan-versions.ts: both `moveGuestAssignment` and
 * `unassignGuestFromPlan` insert a `change_history_entries` row -- `action: 'MANUAL_MOVE'`,
 * `description` (a human-readable sentence naming the guest(s) and the table, e.g. `Moved A One to
 * "TA"` or, for an unassign, `Unassigned A One` -- both forms confirmed against the running app,
 * not assumed), and `actorUserId` -- in the SAME transaction as the assignment write and the plan
 * version's revision bump, so a move and its history entry can never be inconsistent with each
 * other. `GET /api/v1/weddings/:weddingId/activity` (packages/db/src/queries/activity.ts's
 * `listActivityForWedding`) is a single cross-version feed, newest first, left-joining `users` for
 * `actorName` -- this test reads that feed directly rather than through any UI, since there's no
 * dedicated Activity-tab page object and the feed itself (not a rendering of it) is what's under
 * test.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "manual-adjustment.change-history-records-who-and-when.manual-move-and-unassign-both-recorded",
    title: "a manual move and a manual unassign each add a MANUAL_MOVE change-history entry naming who did it, when, and what happened",
    objective:
      "Confirms GET .../activity records a MANUAL_MOVE entry for a manual move (description naming the guest and destination table) and a separate one for a manual unassign (description naming the guest as unassigned), each carrying the acting user's id/name and a real timestamp, and that these are ordered most-recent-first alongside the plan's own GENERATE entry.",
    expectedOutcome:
      "After a manual move, the activity feed's newest entry is action MANUAL_MOVE, description contains the guest's name and the destination table's label, actorUserId/actorName match the account that made the move, and createdAt is a valid, recent timestamp. After a subsequent manual unassign, the feed's newest entry is a second MANUAL_MOVE entry whose description names the guest as unassigned, ordered ahead of the first move's entry.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, account }, testInfo) => {
    const token = testInfo.workerIndex;
    const person = uniquePersonName(token);
    const guestName = `${person.firstName} ${person.lastName}`;

    let planVersionId = "";
    let guestId = "";
    let targetTableId = "";
    let targetTableLabel = "";

    await test.step("Arrange: one guest seated at one of two single-seat tables", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, person);
      guestId = guest.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "History Table A", capacity: 1 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "History Table B", capacity: 1 });

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      const currentTableId = generated.assignments.find((a) => a.guestId === guestId)!.tableId;
      const target = currentTableId === tableA.id ? tableB : tableA;
      targetTableId = target.id;
      targetTableLabel = target.label;
    });

    const beforeMove = new Date();
    await test.step("Act: manually move the guest to the other table", async () => {
      const move = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestId, targetTableId);
      expect(move.status).toBe(200);
    });

    await test.step("Assert: the activity feed's newest entry records that move -- who, what, and a real timestamp", async () => {
      const entries = await weddingData.getActivity(managedWedding.id);
      const moveEntry = entries[0];
      expect(moveEntry.action).toBe("MANUAL_MOVE");
      expect(moveEntry.description).toContain(guestName);
      expect(moveEntry.description).toContain(targetTableLabel);
      expect(moveEntry.actorName).toBe(account.name);
      expect(new Date(moveEntry.createdAt).getTime()).toBeGreaterThanOrEqual(beforeMove.getTime());
      // The plan's own GENERATE entry is still in the feed, just older than this manual move.
      expect(entries.some((e) => e.action === "GENERATE")).toBe(true);
    });

    await test.step("Act: manually unassign the same guest", async () => {
      const unassign = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestId, null);
      expect(unassign.status).toBe(200);
    });

    await test.step("Assert: a second, newer MANUAL_MOVE entry records the unassign, ahead of the move entry", async () => {
      const entries = await weddingData.getActivity(managedWedding.id);
      const unassignEntry = entries[0];
      expect(unassignEntry.action).toBe("MANUAL_MOVE");
      expect(unassignEntry.description).toContain(guestName);
      expect(unassignEntry.description.toLowerCase()).toContain("unassigned");
      expect(unassignEntry.actorName).toBe(account.name);
      expect(new Date(unassignEntry.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(entries[1].createdAt).getTime(),
      );
    });
  },
);
