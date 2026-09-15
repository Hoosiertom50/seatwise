/**
 * TS-45 (REQ-DAY-OF-EMERGENCY-MODE) — converts AC-064 ("Day-of changes appear in the same history
 * as any other edit").
 *
 * Traced directly in packages/db/src/queries/plan-versions.ts: each of Day-of mode's three
 * distinct actions writes its own change-history action type, all into the exact same
 * `change_history_entries` table (and so the exact same `GET .../activity` feed) TS-44 already
 * proved records ordinary manual moves -- confirming there is no separate "day-of log":
 *   - `setGuestAttendance` -> action 'ATTENDANCE_CHANGE'
 *   - seating a walk-in (or any Unassigned guest) -> the same manual-move code path as a plain
 *     move -> action 'MANUAL_MOVE' (TS-44)
 *   - `swapGuestAssignments` -> action 'MANUAL_SWAP'
 * This test performs one of each Day-of action (through the same API endpoints Day-of mode's own
 * UI calls) and confirms all three appear, correctly described and attributed, in the one activity
 * feed -- alongside the plan's own GENERATE entry -- in newest-first order. No UI interaction is
 * needed here: the activity feed itself (not a rendering of it) is what AC-064 is actually about.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "day-of-mode.changes-appear-in-the-same-change-history.attendance-move-and-swap-all-recorded",
    title: "an attendance change, a walk-in-style seating, and a swap each add their own entry to the same activity feed as any other edit",
    objective:
      "Confirms Day-of mode's three distinct actions -- marking a guest Not Attending, seating an Unassigned guest, and swapping two guests -- each write to the same GET .../activity feed as an ordinary manual move: ATTENDANCE_CHANGE, MANUAL_MOVE, and MANUAL_SWAP respectively, each naming who/what happened and carrying the acting account's name.",
    expectedOutcome:
      "After all three actions, the activity feed's three newest entries are, in order: a MANUAL_SWAP entry naming both swapped guests, a MANUAL_MOVE entry naming the newly-seated guest and their table, and an ATTENDANCE_CHANGE entry naming the guest marked not attending and that their seat was freed -- each carrying the acting account's name, with the plan's own (older) GENERATE entry still present further back in the feed.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, account }, testInfo) => {
    const token = testInfo.workerIndex;

    const attendanceGuest = uniquePersonName(token);
    const attendanceGuestName = `${attendanceGuest.firstName} ${attendanceGuest.lastName}`;
    const seatGuest = uniquePersonName(token);
    const seatGuestName = `${seatGuest.firstName} ${seatGuest.lastName}`;
    const swapA = uniquePersonName(token);
    const swapAName = `${swapA.firstName} ${swapA.lastName}`;
    const swapB = uniquePersonName(token);
    const swapBName = `${swapB.firstName} ${swapB.lastName}`;

    let planVersionId = "";
    let attendanceGuestId = "";
    let seatGuestId = "";
    let seatTableId = "";
    let seatTableLabel = "";
    let swapAId = "";
    let swapBId = "";

    await test.step("Arrange: a decoy guest/table pair to seed a Current plan version", async () => {
      const decoyGuest = await weddingData.createGuest(managedWedding.id, uniquePersonName(token));
      const decoyTable = await weddingData.createTable(managedWedding.id, { label: "Decoy", capacity: 1 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      expect(generated.assignments.find((a) => a.guestId === decoyGuest.id)?.tableId).toBe(decoyTable.id);
    });

    await test.step("Arrange: a seated guest (for the attendance change), an unassigned guest and a spare table (for the seating), and two seated guests (for the swap) -- all placed by explicit manual moves, never generation", async () => {
      const forAttendance = await weddingData.createGuest(managedWedding.id, attendanceGuest);
      attendanceGuestId = forAttendance.id;
      const homeTable = await weddingData.createTable(managedWedding.id, { label: "Home Table", capacity: 1 });
      const seat = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, attendanceGuestId, homeTable.id);
      expect(seat.status).toBe(200);

      const forSeating = await weddingData.createGuest(managedWedding.id, seatGuest);
      seatGuestId = forSeating.id;
      const spareTable = await weddingData.createTable(managedWedding.id, { label: "Spare Table", capacity: 1 });
      seatTableId = spareTable.id;
      seatTableLabel = spareTable.label;
      // forSeating is intentionally left with no assignment at all -- created after generation,
      // it starts Unassigned exactly like a freshly-added walk-in would.

      const forSwapA = await weddingData.createGuest(managedWedding.id, swapA);
      swapAId = forSwapA.id;
      const forSwapB = await weddingData.createGuest(managedWedding.id, swapB);
      swapBId = forSwapB.id;
      const swapTableA = await weddingData.createTable(managedWedding.id, { label: "History Swap A", capacity: 1 });
      const swapTableB = await weddingData.createTable(managedWedding.id, { label: "History Swap B", capacity: 1 });
      const seatA = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, swapAId, swapTableA.id);
      expect(seatA.status).toBe(200);
      const seatB = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, swapBId, swapTableB.id);
      expect(seatB.status).toBe(200);
    });

    await test.step("Act: mark the first guest Not Attending", async () => {
      const res = await weddingData.setAttendance(managedWedding.id, attendanceGuestId, "NOT_ATTENDING");
      expect(res.status).toBe(200);
    });

    await test.step("Act: seat the previously-unassigned guest at the spare table", async () => {
      const res = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, seatGuestId, seatTableId);
      expect(res.status).toBe(200);
    });

    await test.step("Act: swap the other two guests' tables", async () => {
      const res = await weddingData.swapGuestAssignments(managedWedding.id, planVersionId, swapAId, swapBId);
      expect(res.status).toBe(200);
    });

    await test.step("Assert: the activity feed's three newest entries are the swap, the seating, and the attendance change -- each attributed to this account, alongside the plan's own (older) GENERATE entry", async () => {
      const entries = await weddingData.getActivity(managedWedding.id);

      const [swapEntry, seatEntry, attendanceEntry] = entries;

      expect(swapEntry.action).toBe("MANUAL_SWAP");
      expect(swapEntry.description).toContain(swapAName);
      expect(swapEntry.description).toContain(swapBName);
      expect(swapEntry.actorName).toBe(account.name);

      expect(seatEntry.action).toBe("MANUAL_MOVE");
      expect(seatEntry.description).toContain(seatGuestName);
      expect(seatEntry.description).toContain(seatTableLabel);
      expect(seatEntry.actorName).toBe(account.name);

      expect(attendanceEntry.action).toBe("ATTENDANCE_CHANGE");
      expect(attendanceEntry.description).toContain(attendanceGuestName);
      expect(attendanceEntry.description.toLowerCase()).toContain("seat freed");
      expect(attendanceEntry.actorName).toBe(account.name);

      expect(entries.some((e) => e.action === "GENERATE")).toBe(true);
      // Newest-first ordering across all four entries this test cares about.
      const times = [swapEntry, seatEntry, attendanceEntry].map((e) => new Date(e.createdAt).getTime());
      expect(times[0]).toBeGreaterThanOrEqual(times[1]);
      expect(times[1]).toBeGreaterThanOrEqual(times[2]);
    });
  },
);
