/**
 * TS-46 (REQ-DAY-OF-TIMELINE) — no manual test case or numbered acceptance criterion exists for
 * this requirement; authored directly from `quality/requirements.yaml`'s REQ-DAY-OF-TIMELINE
 * description plus the actual implementation, per the Jira ticket's own instruction.
 *
 * Covers "editing an entry" (TS-46's own scope): confirmed directly in
 * packages/db/src/queries/timeline.ts's `updateTimelineEntry` that changing an entry's `time`
 * re-sorts it into its new chronological position, that editing only `description` (a partial
 * PATCH) leaves `time`/`sortOrder` untouched, and that editing is exposed through the UI's own
 * inline edit form (TimelineTab.tsx's `editingId` state).
 *
 * A real gap found while verifying this empirically against the running app, documented here
 * rather than worked around: `updateTimelineEntry` changes `time` without ever recomputing
 * `sortOrder` for the *destination* time group -- so an edit that moves an entry into a time group
 * which already has an entry at that same `sortOrder` value produces two entries sharing both
 * `time` and `sortOrder`. The list's own ORDER BY (time, sortOrder) has no third tiebreaker column,
 * so which of the two colliding entries then sorts first is left entirely to Postgres's own
 * (unspecified) tie behavior, and neither one's own "reorder" UP/DOWN can ever separate them again
 * (reorder's neighbor lookup is `sortOrder <` / `sortOrder >`, which a tied value never satisfies
 * against the other tied entry). This is a narrow, low-probability edge case -- ordinary use adds
 * entries one at a time via the UI, which always computes a fresh max+1 -- but it is real,
 * reproducible product behavior, asserted below as a documented gap rather than silently ignored.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";

defineQualityTest(
  {
    id: "timeline.edit-an-entry-updates-time-and-description.re-sorts-on-time-change-and-leaves-order-alone-on-description-only",
    title: "editing an entry's time re-sorts it into its new chronological position; editing only its description leaves the list order unchanged",
    objective:
      "Confirms editing a timeline entry's time moves it to the correct chronological position among the wedding's other entries, that editing only its description (leaving time untouched) does not change list order, and documents a real edge case where editing time into an occupied sortOrder in the destination time group leaves two entries with a colliding sortOrder that reorder can never resolve.",
    expectedOutcome:
      "After editing an entry's time from later in the day to earlier: it now appears first in the run-of-show list, both via the API and the UI. After editing only its description: its position in the list and its own time are both unchanged. A deliberately-collided edit (time moved into a group already occupied at the same sortOrder) leaves both entries reporting the same time and sortOrder.",
    requirementIds: ["REQ-DAY-OF-TIMELINE"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const timeline = new TimelineTabPage(page);

    const firstDance = `First dance ${uniqueToken(token)}`;
    const guestArrival = `Guest arrival ${uniqueToken(token)}`;

    let firstDanceId = "";

    await test.step("Arrange: two entries, the one under test scheduled later in the day", async () => {
      const arrival = await weddingData.createTimelineEntry(managedWedding.id, { time: "14:00", description: guestArrival });
      expect(arrival.status).toBe(201);
      const dance = await weddingData.createTimelineEntry(managedWedding.id, { time: "20:00", description: firstDance });
      expect(dance.status).toBe(201);
      firstDanceId = dance.body.entry!.id;

      const before = await weddingData.getTimelineEntries(managedWedding.id);
      expect(before.map((e) => e.description)).toEqual([guestArrival, firstDance]);
    });

    await test.step("Act: open the Timeline tab and edit the later entry's time to earlier in the day", async () => {
      await timeline.goto(managedWedding.id);
      await timeline.startEdit(firstDance);
      await timeline.saveEdit("13:00", firstDance);
    });

    await test.step("Assert: it now sorts first, both via the API and the UI", async () => {
      const after = await weddingData.getTimelineEntries(managedWedding.id);
      expect(after.map((e) => e.description)).toEqual([firstDance, guestArrival]);
      expect(after[0].time).toBe("13:00");

      const list = timeline.entryRows();
      await expect(list.nth(0)).toContainText(firstDance);
      await expect(list.nth(1)).toContainText(guestArrival);
    });

    await test.step("Act + Assert: editing only the description (via the API, leaving time untouched) does not change time or list order", async () => {
      const renamed = `${firstDance} (renamed)`;
      const res = await weddingData.updateTimelineEntry(managedWedding.id, firstDanceId, { description: renamed });
      expect(res.status).toBe(200);
      expect(res.body.entry!.time).toBe("13:00");

      const after = await weddingData.getTimelineEntries(managedWedding.id);
      expect(after.map((e) => e.description)).toEqual([renamed, guestArrival]);
    });

    await test.step("Documented gap: editing an entry's time into a time group that already occupies its exact sortOrder leaves both entries sharing (time, sortOrder)", async () => {
      const soloA = `Solo A ${uniqueToken(token)}`;
      const soloB = `Solo B ${uniqueToken(token)}`;
      const entryA = await weddingData.createTimelineEntry(managedWedding.id, { time: "10:00", description: soloA });
      const entryB = await weddingData.createTimelineEntry(managedWedding.id, { time: "11:00", description: soloB });
      // Both are alone in their own time group, so the API assigns each sortOrder 0.
      expect(entryA.body.entry!.sortOrder).toBe(0);
      expect(entryB.body.entry!.sortOrder).toBe(0);

      const collided = await weddingData.updateTimelineEntry(managedWedding.id, entryA.body.entry!.id, { time: "11:00" });
      expect(collided.status).toBe(200);
      expect(collided.body.entry!.time).toBe("11:00");
      expect(collided.body.entry!.sortOrder).toBe(0); // unchanged -- never recomputed for the new group

      const entries = await weddingData.getTimelineEntries(managedWedding.id);
      const atElevenOClock = entries.filter((e) => e.time === "11:00");
      expect(atElevenOClock.map((e) => e.description).sort()).toEqual([soloA, soloB].sort());
      expect(atElevenOClock[0].sortOrder).toBe(0);
      expect(atElevenOClock[1].sortOrder).toBe(0);
    });
  },
);
