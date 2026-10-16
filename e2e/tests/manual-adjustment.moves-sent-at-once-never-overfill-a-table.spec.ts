/**
 * Review 14 (REQ-MANUAL-ADJUSTMENT) — manual moves sent at the same moment never seat more people at
 * a table than it has seats, even when they're sent without expectedRevision. The hard rules
 * (room at the table, must-not-sit-together, accessible, Restricted lists) were checked only
 * before the move's transaction, so 12 moves sent at once into a table with one or two seats left
 * all succeeded and the table ended at 20 of 10 (the extras flagged afterwards). They're now
 * checked again under the plan's lock. The web app always sends expectedRevision; this is about any
 * other client (and Undo's replay, which sends none).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "manual-adjustment.moves-sent-at-once-never-overfill-a-table.no-expected-revision",
    title: "eight moves sent at once, without expectedRevision, into a two-seat table: two are seated and the other six are refused",
    objective:
      "Confirms (review 14) that the room-at-the-table check runs again under the plan's lock: with ten guests seated at a 20-seat table and a new 2-seat table, eight moves into the 2-seat table sent at the same moment without expectedRevision seat exactly two guests there; the other six get 409 saying the table has no seats left, nothing answers 5xx, and nobody at the table is flagged Needs Reassignment.",
    expectedOutcome:
      "Exactly 2 moves answer 200 and 6 answer 409 (\"only has 0 seat(s) left\"); none 5xx. Afterwards the 2-seat table holds 2 guests, none flagged, and the plan has no Needs Reassignment flags.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    const w = managedWedding.id;
    const guestIds: string[] = [];
    let planVersionId = "";
    let smallTableId = "";

    await test.step("Arrange: ten guests seated at a 20-seat table, then a new 2-seat table", async () => {
      for (let i = 0; i < 10; i++) {
        const person = uniquePersonName(testInfo.workerIndex);
        guestIds.push((await weddingData.createGuest(w, person)).id);
      }
      await weddingData.createTable(w, { label: "Room For All", capacity: 20 });
      const generated = await weddingData.generatePlanVersion(w);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      smallTableId = (await weddingData.createTable(w, { label: "Two Seats", capacity: 2 })).id;
    });

    await test.step("Act: eight moves into the 2-seat table at once, without expectedRevision", async () => {
      const results = await Promise.all(
        guestIds.slice(0, 8).map((g) => weddingData.moveGuestAssignment(w, planVersionId, g, smallTableId))
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
      expect(statuses.filter((s) => s === 200)).toHaveLength(2);
      expect(statuses.filter((s) => s === 409)).toHaveLength(6);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.error).toMatch(/only has 0 seat\(s\) left/);
    });

    await test.step("The 2-seat table holds two guests and nobody is flagged", async () => {
      const detail = await weddingData.getPlanVersionDetail(w, planVersionId);
      const atSmall = detail.assignments.filter((a) => a.tableId === smallTableId);
      expect(atSmall).toHaveLength(2);
      expect(detail.assignments.filter((a) => a.needsReassignment)).toEqual([]);
    });
  },
);
