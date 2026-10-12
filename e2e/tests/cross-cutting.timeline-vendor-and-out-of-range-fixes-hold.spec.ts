/**
 * TS-174 (REQ-DAY-OF-TIMELINE, REQ-BUDGET-VENDOR-TRACKING, REQ-NON-FUNCTIONAL) — smaller fixes.
 * - Timeline entries tied on position (as entries saved before TS-153 can be) are listed and
 *   reordered in the same order, so "Up" swaps with the entry shown just above; and an entry whose
 *   time changes while it's being reordered gets a 409, not a server error.
 * - Moving a vendor off "Other" drops its "Other" label, so it doesn't follow the vendor into
 *   suggestions on the planner's other weddings.
 * - Values the database can't store are a 422: an expectedRevision past the int4 range (budget,
 *   guest, timeline) and a wedding date in year 0000 or far outside 1900-2200.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { holdTimelineEntry, plantTimelineTie } from "../support/testDatabase.js";
import { patchWedding } from "../data/api.js";

defineQualityTest(
  {
    id: "cross-cutting.timeline-vendor-and-out-of-range-fixes-hold.ties-category-label-422s",
    title: "tied timeline entries reorder as listed, a reorder racing a time change is a 409, a vendor moved off Other loses its label, and out-of-range revisions and dates are 422s",
    objective:
      "Confirms that three timeline entries planted with the same position are listed in creation order and that moving the last one up swaps it with the entry shown just above it; that a reorder held while the entry's time is changed returns 409 and changes nothing; that changing an Other vendor's category clears its Other label and the planner's suggestions show no label for it; and that an expectedRevision of 3,000,000,000 on the budget, a guest and a timeline entry, and wedding dates of 0000-01-01 and 9999-12-31, are each refused with 422.",
    expectedOutcome:
      "Listed [First, Second, Third]; after Third goes up, [First, Third, Second]. The held reorder returns 409 and the remaining entries keep their order. The vendor's categoryOther is null after the change and its suggestion has categoryOther null. Every out-of-range value returns 422 with a field error on the offending field.",
    requirementIds: ["REQ-DAY-OF-TIMELINE", "REQ-BUDGET-VENDOR-TRACKING", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:timeline", "@feature:budget", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const descriptions = async () => (await weddingData.getTimelineEntries(w)).map((e) => e.description);

    await test.step("Tied entries are listed and reordered in the same order", async () => {
      const create = async (description: string) => (await weddingData.createTimelineEntry(w, { time: "15:00", description })).body.entry!;
      // Created in one order, then given creation times in another, all at position 0.
      const third = await create("Third");
      const first = await create("First");
      const second = await create("Second");
      await plantTimelineTie(w, [first.id, second.id, third.id]);
      expect(await descriptions()).toEqual(["First", "Second", "Third"]);
      expect((await weddingData.reorderTimelineEntry(w, third.id, "UP")).status).toBe(200);
      expect(await descriptions()).toEqual(["First", "Third", "Second"]);
    });

    await test.step("A reorder racing a change of the entry's time is a 409", async () => {
      const entries = await weddingData.getTimelineEntries(w);
      const moving = entries.find((e) => e.description === "Second")!;
      const held = await holdTimelineEntry(moving.id);
      let pending;
      try {
        pending = weddingData.reorderTimelineEntry(w, moving.id, "UP");
        await held.waitForWaiters(1);
        await held.moveToTimeAndRelease("23:30");
      } finally {
        await held.release();
      }
      const result = await pending;
      expect(result.status).toBe(409);
      expect(await descriptions()).toEqual(["First", "Third", "Second"]);
    });

    await test.step("A vendor moved off Other loses its Other label, in suggestions too", async () => {
      const name = `Vendor Label ${testInfo.workerIndex}-${Date.now()}`;
      const created = await context.request.post(api("vendors"), { data: { name, category: "OTHER", categoryOther: "Officiant" } });
      expect(created.status()).toBe(201);
      const vendor = ((await created.json()) as { vendor: { id: string; revision: number } }).vendor;
      const changed = await context.request.patch(api(`vendors/${vendor.id}`), {
        data: { category: "CATERING", expectedRevision: vendor.revision },
      });
      expect(changed.status()).toBe(200);
      const fresh = ((await (await context.request.get(api("vendors"))).json()) as { vendors: { id: string; category: string; categoryOther: string | null }[] })
        .vendors.find((v) => v.id === vendor.id)!;
      expect(fresh.category).toBe("CATERING");
      expect(fresh.categoryOther).toBeNull();

      // Offered on the planner's other weddings without the old label.
      const other = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Suggestions"));
      const res = await context.request.get(`/api/v1/vendor-suggestions?excludeWeddingId=${other.id}`);
      expect(res.status()).toBe(200);
      const suggestion = ((await res.json()) as { suggestions: { name: string; category: string; categoryOther: string | null }[] })
        .suggestions.find((s) => s.name === name)!;
      expect(suggestion.category).toBe("CATERING");
      expect(suggestion.categoryOther).toBeNull();
    });

    await test.step("Values the database can't store are refused with 422", async () => {
      const tooBig = 3_000_000_000;
      const budget = await context.request.patch(api("budget"), { data: { budgetCents: 1000, expectedRevision: tooBig } });
      expect(budget.status()).toBe(422);
      expect(((await budget.json()) as { fieldErrors: Record<string, unknown> }).fieldErrors.expectedRevision).toBeTruthy();

      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const guestRes = await context.request.patch(api(`guests/${guest.id}`), { data: { notes: "x", expectedRevision: tooBig } });
      expect(guestRes.status()).toBe(422);

      const entry = (await weddingData.getTimelineEntries(w))[0];
      const entryRes = await context.request.patch(api(`timeline-entries/${entry.id}`), { data: { description: "x", expectedRevision: tooBig } });
      expect(entryRes.status()).toBe(422);

      for (const eventDate of ["0000-01-01", "9999-12-31"]) {
        const res = await patchWedding(context.request, w, { data: { eventDate } });
        expect(res.status(), eventDate).toBe(422);
        expect(((await res.json()) as { fieldErrors: Record<string, unknown> }).fieldErrors.eventDate, eventDate).toBeTruthy();
      }
      const cutoff = await patchWedding(context.request, w, { data: { rsvpCutoffDate: "0000-01-01" } });
      expect(cutoff.status()).toBe(422);
    });
  },
);
