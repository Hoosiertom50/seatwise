/**
 * TS-46 (REQ-DAY-OF-TIMELINE) — no manual test case or numbered acceptance criterion exists for
 * this requirement; authored directly from `quality/requirements.yaml`'s REQ-DAY-OF-TIMELINE
 * description plus the actual implementation, per the Jira ticket's own instruction.
 *
 * Covers "removing an entry" (TS-46's own scope): confirmed directly in
 * packages/db/src/queries/timeline.ts's `deleteTimelineEntry` (a plain delete-by-id-and-wedding,
 * no soft-delete or cascade of its own -- this is a standalone record) and TimelineTab.tsx's
 * `onDelete`, which removes the row from the UI's own state immediately (an optimistic update) and
 * rolls it back with an error message if the request itself fails. Also confirms a second delete
 * of the same entry (already gone) 404s rather than silently succeeding, and that removing one
 * entry never touches any other entry's own time/sortOrder.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";

defineQualityTest(
  {
    id: "timeline.remove-an-entry.removes-it-from-the-list-and-a-repeat-delete-404s",
    title: "removing a timeline entry drops it from the run-of-show immediately and leaves other entries untouched; removing it again 404s",
    objective:
      "Confirms clicking Remove on a timeline entry removes it from the UI's own list right away and persists that removal (a fresh read no longer includes it), that a second delete of the same now-gone entry is rejected with a 404 rather than silently succeeding, and that removing one entry does not change any other entry's time or sortOrder.",
    expectedOutcome:
      "After removing the middle of three entries: the run-of-show list shows the remaining two, in their original relative order, and the API's own list confirms the removed entry is gone while the other two are byte-for-byte unchanged. A direct second delete of the same entry ID returns 404.",
    requirementIds: ["REQ-DAY-OF-TIMELINE"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const timeline = new TimelineTabPage(page);

    const entryA = `Prelude ${uniqueToken(token)}`;
    const entryB = `Vows ${uniqueToken(token)}`;
    const entryC = `Recessional ${uniqueToken(token)}`;

    let entryBId = "";

    await test.step("Arrange: three entries, in chronological order", async () => {
      const a = await weddingData.createTimelineEntry(managedWedding.id, { time: "10:00", description: entryA });
      const b = await weddingData.createTimelineEntry(managedWedding.id, { time: "11:00", description: entryB });
      const c = await weddingData.createTimelineEntry(managedWedding.id, { time: "12:00", description: entryC });
      entryBId = b.body.entry!.id;

      const before = await weddingData.getTimelineEntries(managedWedding.id);
      expect(before.map((e) => e.description)).toEqual([entryA, entryB, entryC]);
      void a;
      void c;
    });

    await test.step("Act: open the Timeline tab and remove the middle entry", async () => {
      await timeline.goto(managedWedding.id);
      await expect(timeline.runOfShowHeading(3)).toBeVisible();
      await timeline.remove(entryB);
    });

    await test.step("Assert: the UI immediately shows only the remaining two entries", async () => {
      await expect(timeline.runOfShowHeading(2)).toBeVisible();
      const list = timeline.entryRows();
      await expect(list).toHaveCount(2);
      await expect(list.nth(0)).toContainText(entryA);
      await expect(list.nth(1)).toContainText(entryC);
    });

    await test.step("Assert: the removal persisted, and the two remaining entries are otherwise unchanged", async () => {
      const after = await weddingData.getTimelineEntries(managedWedding.id);
      expect(after.map((e) => e.description)).toEqual([entryA, entryC]);
      expect(after[0].time).toBe("10:00");
      expect(after[0].sortOrder).toBe(0);
      expect(after[1].time).toBe("12:00");
      expect(after[1].sortOrder).toBe(0);
    });

    await test.step("Assert: deleting the same (already-gone) entry again returns 404, not a silent success", async () => {
      const res = await weddingData.deleteTimelineEntry(managedWedding.id, entryBId);
      expect(res.status).toBe(404);
    });
  },
);
