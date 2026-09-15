/**
 * TS-46 (REQ-DAY-OF-TIMELINE) — no manual test case or numbered acceptance criterion exists for
 * this requirement (it predates the planner-pivot roadmap and has no workbook row); authored
 * directly from `quality/requirements.yaml`'s REQ-DAY-OF-TIMELINE description plus the actual
 * implementation, per the Jira ticket's own instruction and `pw-author-test`.
 *
 * Covers "creating an entry" (TS-46's own scope, per its Jira description): confirmed directly in
 * packages/db/src/queries/timeline.ts (`createTimelineEntry`, `listTimelineEntriesForWedding`) and
 * empirically against the running app that entries are always listed by (time, sortOrder) --
 * chronological regardless of creation order -- and that a new entry sharing an existing entry's
 * exact `time` is appended after them (sortOrder = that time group's current max + 1), never
 * inserted arbitrarily among them. Also confirmed the UI's own 12-hour `formatTime` display
 * (TimelineTab.tsx), including the two edge cases a naive `% 12` could get wrong: midnight ("00:00"
 * -> "12:00 AM") and noon ("12:00" -> "12:00 PM").
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";

defineQualityTest(
  {
    id: "timeline.add-an-entry-appends-chronologically.new-entries-sort-by-time-then-append-within-a-tied-time",
    title: "adding timeline entries out of time order always displays them chronologically, and an entry sharing an existing time is appended after it",
    objective:
      "Confirms new run-of-show entries are always listed in (time, sortOrder) order regardless of the order they were added in, that an entry added with the exact same time as an existing one is appended after it rather than inserted arbitrarily, and that the UI's 12-hour time display is correct at the midnight/noon edge cases.",
    expectedOutcome:
      "After adding entries for 18:00, then 09:00, then a second 18:00 entry: the run-of-show list reads 09:00, then both 18:00 entries in the order they were added (the second after the first). A midnight (00:00) entry displays as '12:00 AM' and a noon (12:00) entry displays as '12:00 PM'.",
    requirementIds: ["REQ-DAY-OF-TIMELINE"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    const timeline = new TimelineTabPage(page);

    const reception = `Reception begins ${uniqueToken(token)}`;
    const ceremony = `Ceremony begins ${uniqueToken(token)}`;
    const cocktailHour = `Cocktail hour ${uniqueToken(token)}`;
    const midnightEntry = `Send-off ${uniqueToken(token)}`;
    const noonEntry = `Lunch service ${uniqueToken(token)}`;

    await test.step("Act: open the Timeline tab and add three entries out of chronological order (18:00, then 09:00, then a second 18:00)", async () => {
      await timeline.goto(managedWedding.id);
      await timeline.addEntry("18:00", reception);
      await expect(timeline.runOfShowHeading(1)).toBeVisible();
      await timeline.addEntry("09:00", ceremony);
      await expect(timeline.runOfShowHeading(2)).toBeVisible();
      await timeline.addEntry("18:00", cocktailHour);
      await expect(timeline.runOfShowHeading(3)).toBeVisible();
    });

    await test.step("Assert: the API's own list is chronological (09:00 first), with the two 18:00 entries in the order they were added", async () => {
      const entries = await weddingData.getTimelineEntries(managedWedding.id);
      const descriptions = entries.map((e) => e.description);
      expect(descriptions).toEqual([ceremony, reception, cocktailHour]);
      expect(entries[1].time).toBe("18:00");
      expect(entries[2].time).toBe("18:00");
      expect(entries[2].sortOrder).toBeGreaterThan(entries[1].sortOrder);
    });

    await test.step("Assert: the UI itself renders the same chronological order", async () => {
      const list = timeline.entryRows();
      await expect(list).toHaveCount(3);
      await expect(list.nth(0)).toContainText(ceremony);
      await expect(list.nth(1)).toContainText(reception);
      await expect(list.nth(2)).toContainText(cocktailHour);
    });

    await test.step("Assert: midnight and noon entries display in 12-hour form, not a raw 24-hour or naively-wrapped label", async () => {
      await timeline.addEntry("00:00", midnightEntry);
      await timeline.addEntry("12:00", noonEntry);
      await expect(timeline.entryTimeText(midnightEntry)).toHaveText("12:00 AM");
      await expect(timeline.entryTimeText(noonEntry)).toHaveText("12:00 PM");
    });

    await test.step("Assert: a schema-invalid time is rejected outright (422) rather than silently accepted or coerced", async () => {
      const nonZeroPadded = await weddingData.createTimelineEntry(managedWedding.id, {
        time: "9:30",
        description: `Bad time ${uniqueToken(token)}`,
      });
      expect(nonZeroPadded.status).toBe(422);

      const outOfRange = await weddingData.createTimelineEntry(managedWedding.id, {
        time: "25:00",
        description: `Bad time ${uniqueToken(token)}`,
      });
      expect(outOfRange.status).toBe(422);

      // Confirms the two rejected attempts above created nothing -- still exactly 5 entries.
      const entries = await weddingData.getTimelineEntries(managedWedding.id);
      expect(entries).toHaveLength(5);
    });
  },
);
