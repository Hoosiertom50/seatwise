/**
 * TS-46 (REQ-DAY-OF-TIMELINE) — no manual test case or numbered acceptance criterion exists for
 * this requirement; authored directly from `quality/requirements.yaml`'s REQ-DAY-OF-TIMELINE
 * description plus the actual implementation, per the Jira ticket's own instruction.
 *
 * Covers "reordering entries" (TS-46's own scope): confirmed directly in
 * packages/db/src/queries/timeline.ts's `reorderTimelineEntry` and TimelineTab.tsx's own
 * `sameTimeAbove`/`sameTimeBelow` computation that "reorder" only ever swaps an entry's sortOrder
 * with a neighbor sharing its *exact same* time -- never across a time boundary, since the list's
 * primary sort is always by time first (FR-13.1's "always chronological" guarantee would otherwise
 * break). An entry with no same-time neighbor in the requested direction is a no-op: the UI
 * disables that arrow outright, and the underlying API call (if made anyway) returns 200 with the
 * entry unchanged rather than erroring.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";

defineQualityTest(
  {
    id: "timeline.reorder-entries-sharing-the-same-time.moves-within-a-tied-time-group-and-never-crosses-a-time-boundary",
    title: "reordering an entry moves it earlier/later only among others sharing its exact time, and is a no-op at the edge of that group or when the entry has no same-time peers",
    objective:
      "Confirms the Timeline tab's reorder controls swap an entry's position only with a neighbor sharing its exact same time, that the arrow in a direction with no such neighbor is disabled in the UI, and that calling the underlying reorder API directly in that same no-neighbor case returns 200 with the entry left unchanged rather than erroring or crossing into a different time group.",
    expectedOutcome:
      "Three entries share 16:00 (A, B, C in that order) and one entry alone at 18:00 (D). Moving B down swaps it with C, giving A, C, B. A's 'move earlier' arrow and B's 'move later' (now-last) arrow are both disabled; D's arrows are both disabled (no same-time peer at all). Calling the reorder API directly on D returns 200 with D's own sortOrder unchanged.",
    requirementIds: ["REQ-DAY-OF-TIMELINE"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const timeline = new TimelineTabPage(page);

    const entryA = `Doors open ${uniqueToken(token)}`;
    const entryB = `Guests seated ${uniqueToken(token)}`;
    const entryC = `Processional ${uniqueToken(token)}`;
    const entryD = `Farewell ${uniqueToken(token)}`;

    let entryDId = "";

    await test.step("Arrange: three entries sharing 16:00 (A, B, C in that creation order) and one alone at 18:00 (D)", async () => {
      const a = await weddingData.createTimelineEntry(managedWedding.id, { time: "16:00", description: entryA });
      const b = await weddingData.createTimelineEntry(managedWedding.id, { time: "16:00", description: entryB });
      const c = await weddingData.createTimelineEntry(managedWedding.id, { time: "16:00", description: entryC });
      const d = await weddingData.createTimelineEntry(managedWedding.id, { time: "18:00", description: entryD });
      entryDId = d.body.entry!.id;

      const before = await weddingData.getTimelineEntries(managedWedding.id);
      expect(before.map((e) => e.description)).toEqual([entryA, entryB, entryC, entryD]);
      expect([a.body.entry!.sortOrder, b.body.entry!.sortOrder, c.body.entry!.sortOrder]).toEqual([0, 1, 2]);
    });

    await test.step("Act: open the Timeline tab and move B down (swapping it with C)", async () => {
      await timeline.goto(managedWedding.id);
      await timeline.moveDown(entryB);
    });

    await test.step("Assert: the order is now A, C, B, D -- both via the API and the UI", async () => {
      const after = await weddingData.getTimelineEntries(managedWedding.id);
      expect(after.filter((e) => e.time === "16:00").map((e) => e.description)).toEqual([entryA, entryC, entryB]);

      const list = timeline.entryRows();
      await expect(list.nth(0)).toContainText(entryA);
      await expect(list.nth(1)).toContainText(entryC);
      await expect(list.nth(2)).toContainText(entryB);
      await expect(list.nth(3)).toContainText(entryD);
    });

    await test.step("Assert: A (now first-of-group) can't move earlier, and B (now last-of-group) can't move later -- both arrows disabled", async () => {
      expect(await timeline.isMoveUpEnabled(entryA)).toBe(false);
      expect(await timeline.isMoveDownEnabled(entryB)).toBe(false);
      // Each still has a same-time neighbor in the OTHER direction, so those arrows stay enabled.
      expect(await timeline.isMoveDownEnabled(entryA)).toBe(true);
      expect(await timeline.isMoveUpEnabled(entryB)).toBe(true);
    });

    await test.step("Assert: D, alone at 18:00, has both arrows disabled -- no same-time peer in either direction", async () => {
      expect(await timeline.isMoveUpEnabled(entryD)).toBe(false);
      expect(await timeline.isMoveDownEnabled(entryD)).toBe(false);
    });

    await test.step("Act + Assert: calling reorder directly on D (bypassing the disabled UI control) is a 200 no-op, not an error or a cross-time-group move", async () => {
      const res = await weddingData.reorderTimelineEntry(managedWedding.id, entryDId, "UP");
      expect(res.status).toBe(200);
      expect(res.body.entry!.id).toBe(entryDId);
      expect(res.body.entry!.time).toBe("18:00");

      const after = await weddingData.getTimelineEntries(managedWedding.id);
      expect(after.map((e) => e.description)).toEqual([entryA, entryC, entryB, entryD]);
    });
  },
);
