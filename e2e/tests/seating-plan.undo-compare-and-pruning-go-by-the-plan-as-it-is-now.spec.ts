/**
 * TS-228 / TS-235 (REQ-MANUAL-ADJUSTMENT, REQ-PLAN-REVIEW-STATUS) — the Seating plan tab and the
 * plan versions go by the plan as it is now, not an older copy.
 * - Undo checked "would this split a must-sit-together group?" against a copy of the rules the
 *   screen fetched just before the undo. A rule added during that round trip slipped through. Now
 *   the undo sends the seats it expects and the server checks the group again under the plan's lock.
 * - The version comparison listed guests who have since declined as seated, and counted them. Now
 *   they're marked "(not attending now)" and left out of the counts (as the version lists, TS-221).
 * - Approved older versions were never pruned (Generate then Approve grew a wedding's versions
 *   without limit), and a brand-new comparison draft could be pruned in its own save when the older
 *   versions were all approved. Now the older approved ones are pruned too (the newest few always
 *   stay) and the version being made never is.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { addOldApprovedPlanVersions } from "../support/testDatabase.js";

const SPLITS_GROUP = "Can't undo — that would split a must-sit-together group.";

defineQualityTest(
  {
    id: "seating-plan.undo-compare-and-pruning-go-by-the-plan-as-it-is-now.undo-is-checked-again-by-the-server",
    title: "an undo is refused by the server when a must-sit-together rule added during the undo would split the group, even though the screen's copy of the rules missed it",
    objective:
      "Confirms that after guest A is moved alone to a third table and a must-sit-together rule linking A to guest B (seated elsewhere) is added, an Undo whose rules check sees the old rule list (the relationships request answered as it was before the rule) is still refused -- by the server, under the plan's lock -- with 'Can't undo — that would split a must-sit-together group.', and nobody moves. Also confirms the server accepts an undo whose seats-before match the group as it is now.",
    expectedOutcome:
      "The refusal message shows; A is still at the third table and B at their own; the Undo entry is gone. A direct undo request listing both A and B as seated at the target before is answered 200; one leaving B out is answered 409 with the same message.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:manual-adjustment", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }, testInfo) => {
    const w = managedWedding.id;
    const a = uniquePersonName(testInfo.workerIndex);
    const aName = `${a.firstName} ${a.lastName}`;
    const aId = (await weddingData.createGuest(w, a)).id;
    const bId = (await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex))).id;
    // One seat each, so the plan seats them apart.
    await weddingData.createTable(w, { label: "First", capacity: 1 });
    await weddingData.createTable(w, { label: "Second", capacity: 1 });
    const plan = await weddingData.generatePlanVersion(w);
    const before = new Map(plan.assignments.map((x) => [x.guestId, x.tableId]));
    expect(before.get(aId)).toBeTruthy();
    expect(before.get(bId)).toBeTruthy();
    const third = await weddingData.createTable(w, { label: "Third", capacity: 4 });
    const seatOf = async (guestId: string) =>
      (await weddingData.getPlanVersionDetail(w, plan.id)).assignments.find((x) => x.guestId === guestId)?.tableId;

    const planTab = new PlanTabPage(page);
    await planTab.goto(w);
    await planTab.showListView();

    await test.step("A moves alone to Third, then a must-sit rule links A and B", async () => {
      await planTab.moveGuestInList(aName, "Third");
      expect(await seatOf(aId)).toBe(third.id);
      await weddingData.createRelationship(w, aId, bId, "MUST_SIT_TOGETHER");
    });

    await test.step("Undo, with the screen's rules check seeing the list from before the rule: the server refuses it", async () => {
      // The rules request is answered as it was a moment before -- the rule "lands during the round trip".
      await page.route(`**/api/v1/weddings/${w}/relationships`, (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ relationships: [] }) })
          : route.fallback(),
      );
      await planTab.undo();
      await expect(planTab.message(SPLITS_GROUP)).toBeVisible();
      expect(await seatOf(aId)).toBe(third.id);
      expect(await seatOf(bId)).toBe(before.get(bId));
      // It can never be done, so it's gone.
      await expect(planTab.undoButton()).toHaveCount(0);
    });

    await test.step("The server goes by the group as it is now", async () => {
      const revision = (await weddingData.getPlanVersionDetail(w, plan.id)).revision;
      const refused = await context.request.post(`/api/v1/weddings/${w}/plan-versions/${plan.id}/assignments`, {
        data: { guestId: aId, tableId: before.get(aId), expectedRevision: revision, undoSeatsBefore: { [aId]: before.get(aId) } },
      });
      expect(refused.status()).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe(SPLITS_GROUP);
      // Both were at Third before (as the request says): the group goes there.
      const accepted = await context.request.post(`/api/v1/weddings/${w}/plan-versions/${plan.id}/assignments`, {
        data: { guestId: aId, tableId: third.id, expectedRevision: revision, undoSeatsBefore: { [aId]: third.id, [bId]: third.id } },
      });
      expect(accepted.status()).toBe(200);
      expect(await seatOf(bId)).toBe(third.id);
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.undo-compare-and-pruning-go-by-the-plan-as-it-is-now.compare-marks-declined-guests",
    title: "the version comparison marks guests who are not attending now and leaves them out of the counts",
    objective:
      "Confirms that after a guest seated in version 1 is marked not attending and version 2 is made, comparing version 1 with version 2 lists that guest as '<name> (not attending now)', says one guest is not attending now and isn't counted, and the summary counts only the guest still attending; the comparison answer marks only that guest notAttending.",
    expectedOutcome:
      "Summary '… 0 moved, 0 added, 0 removed, 1 unchanged'; the decliner's row shows '<name> (not attending now)'; the note reads '1 guest is not attending now — listed below, but not counted.'; the API marks only the decliner.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:day-of-mode", "@risk:low", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }, testInfo) => {
    const w = managedWedding.id;
    const decliner = uniquePersonName(testInfo.workerIndex);
    const declinerName = `${decliner.firstName} ${decliner.lastName}`;
    const declinerId = (await weddingData.createGuest(w, decliner)).id;
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "Main", capacity: 8 });
    const v1 = await weddingData.generatePlanVersion(w);
    const v2 = await weddingData.generatePlanVersion(w);
    // Declined once v1 is no longer current: declining frees their seat in the current plan (v2)
    // only, so the older v1 still holds it.
    expect((await weddingData.setAttendance(w, declinerId, "NOT_ATTENDING")).status).toBe(200);

    await test.step("The comparison answer marks only the decliner, and doesn't count them", async () => {
      const res = await context.request.get(`/api/v1/weddings/${w}/plan-versions/compare?from=${v1.id}&to=${v2.id}`);
      expect(res.status()).toBe(200);
      const { comparison } = (await res.json()) as {
        comparison: { guests: { guestId: string; notAttending?: boolean }[]; summary: Record<string, number> };
      };
      expect(comparison.guests.filter((g) => g.notAttending).map((g) => g.guestId)).toEqual([declinerId]);
      expect(comparison.summary).toEqual({ movedCount: 0, addedCount: 0, removedCount: 0, unchangedCount: 1 });
    });

    await test.step("The Plan tab's comparison says so", async () => {
      const planTab = new PlanTabPage(page);
      await planTab.goto(w);
      await planTab.openComparison();
      await planTab.compare(/^v1\b/, /^v2\b/);
      await expect(planTab.comparisonSummary()).toContainText("0 moved, 0 added, 0 removed, 1 unchanged");
      await expect(planTab.comparisonNotAttendingNote()).toHaveText("1 guest is not attending now — listed below, but not counted.");
      await expect(planTab.comparisonRow(`${declinerName} (not attending now)`)).toHaveCount(1);
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.undo-compare-and-pruning-go-by-the-plan-as-it-is-now.approved-versions-are-pruned-but-never-the-new-one",
    title: "with many approved older versions, a new comparison draft is kept and opens, and the versions stay within the cap",
    objective:
      "Confirms that a wedding with 49 older approved versions (plus its current plan) that generates a comparison draft keeps that draft -- it opens and can be restored -- with the oldest approved version pruned instead; and that a wedding given 120 older approved versions is brought back to at most 50 by its next Generate, with the newest older approved ones kept.",
    expectedOutcome:
      "The new draft's detail answers 200 and its restore 201; the wedding has 50 versions. After 120 more approved versions and a Generate, the wedding has at most 50 versions and still has its 5 newest older approved ones.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:low", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    await weddingData.createTable(w, { label: "Main", capacity: 8 });
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.generatePlanVersion(w);

    await test.step("49 approved older versions: a new comparison draft survives its own save", async () => {
      await addOldApprovedPlanVersions(w, 49);
      const res = await context.request.post(`/api/v1/weddings/${w}/plan-versions/generate`, { data: { makeCurrent: false } });
      expect(res.status()).toBe(201);
      const draftId = ((await res.json()) as { planVersion: { id: string } }).planVersion.id;
      expect((await context.request.get(`/api/v1/weddings/${w}/plan-versions/${draftId}`)).status()).toBe(200);
      const all = await weddingData.listPlanVersions(w);
      expect(all).toHaveLength(50);
      expect(all.some((v) => v.id === draftId)).toBe(true);
      const restored = await weddingData.restoreVersion(w, draftId);
      expect(restored.status).toBe(201);
    });

    await test.step("120 approved older versions are pruned back to the cap by the next Generate", async () => {
      await addOldApprovedPlanVersions(w, 120);
      await weddingData.generatePlanVersion(w);
      const all = await weddingData.listPlanVersions(w);
      expect(all.length).toBeLessThanOrEqual(50);
      const olderApproved = all.filter((v) => v.status === "APPROVED" && !v.isCurrent);
      expect(olderApproved.length).toBeGreaterThanOrEqual(5);
    });
  },
);
