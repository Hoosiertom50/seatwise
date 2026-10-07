/**
 * TS-221 (REQ-MANUAL-ADJUSTMENT, REQ-PLAN-REVIEW-STATUS) — the Seating plan tab while it stays open.
 * - Its table list loaded once: guests seated (elsewhere) at a table added since showed under no
 *   table at all, the new table wasn't offered in "Move to…", and a table removed elsewhere still
 *   was. Now the list is fetched again every 4 seconds, and a seated table not in it yet is drawn.
 * - A version removed while open (older versions are pruned once a wedding has many) left every
 *   action saying "Plan version not found". Now the tab opens the current plan and says why.
 * - An older version listed guests who had since declined as if seated. Now they're marked.
 * - Undo of a move whose must-sit-together group was split before it put a partner at a table they
 *   were never at. Now it's refused. Moves are announced for screen readers.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { failRequests } from "../support/networkFaults.js";
import { removePlanVersionAsPruningWould } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "seating-plan.keeps-up-with-tables-removed-versions-and-split-groups.tables-added-and-removed-elsewhere",
    title: "the open Seating plan tab shows a table added elsewhere with the guests seated there, and stops offering a table removed elsewhere",
    objective:
      "Confirms that with the Seating plan tab open, a table added through the API and a guest moved to it through the API both show (the table's card lists the guest) without reloading, the new table is offered in another guest's Move list, and a table removed through the API stops being offered.",
    expectedOutcome:
      "Within 10 seconds 'Late Table' has a card listing the moved guest and is offered to the other guest; 'Spare' is no longer offered once removed.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const first = uniquePersonName(testInfo.workerIndex);
    const second = uniquePersonName(testInfo.workerIndex);
    const firstName = `${first.firstName} ${first.lastName}`;
    const secondName = `${second.firstName} ${second.lastName}`;
    const firstId = (await weddingData.createGuest(w, first)).id;
    await weddingData.createGuest(w, second);
    await weddingData.createTable(w, { label: "Main", capacity: 8 });
    const plan = await weddingData.generatePlanVersion(w);
    // Added after the plan, so nobody is seated at it.
    const spare = await weddingData.createTable(w, { label: "Spare", capacity: 8 });

    const planTab = new PlanTabPage(page);
    await planTab.goto(w);
    await planTab.showListView();

    await test.step("A table added elsewhere shows, with the guest seated there elsewhere", async () => {
      const late = await weddingData.createTable(w, { label: "Late Table", capacity: 4 });
      const moved = await weddingData.moveGuestAssignment(w, plan.id, firstId, late.id);
      expect(moved.status).toBe(200);
      await expect(planTab.listTableCard("Late Table")).toContainText(firstName, { timeout: 10_000 });
      await expect.poll(() => planTab.listMoveChoices(secondName), { timeout: 10_000 }).toContain("Late Table");
    });

    await test.step("A table removed elsewhere is no longer offered", async () => {
      await expect.poll(() => planTab.listMoveChoices(secondName), { timeout: 10_000 }).toContain("Spare");
      const res = await page.request.delete(`/api/v1/weddings/${w}/tables/${spare.id}`);
      expect(res.status()).toBe(200);
      await expect.poll(() => planTab.listMoveChoices(secondName), { timeout: 10_000 }).not.toContain("Spare");
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.keeps-up-with-tables-removed-versions-and-split-groups.removed-version-opens-the-current-plan",
    title: "a version removed while it's open (pruned) makes the Seating plan tab open the current plan and say why, from its 4-second check or from an action",
    objective:
      "Confirms that when the open version stops being current and is removed before the tab's next check sees it, the tab opens the current plan with 'The version you had open was removed — you're now looking at the current plan.'; and that when an older version opened from the list is removed, pressing 'Restore version N...' does the same instead of saying 'Plan version not found'.",
    expectedOutcome:
      "Version 2's badge shows with the removed-version notice after the check. After version 2 is opened from the list and removed, Restore opens version 3 with the same notice, and 'Plan version not found' is never shown.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "Main", capacity: 8 });
    const v1 = await weddingData.generatePlanVersion(w);

    const planTab = new PlanTabPage(page);
    await planTab.goto(w);
    await expect(planTab.openVersionBadge(1)).toBeVisible();

    await test.step("The open version is replaced and removed between two checks: the current plan opens", async () => {
      // The tab's checks of version 1 fail while it is replaced and removed, so the next real check
      // finds it gone (rather than merely no longer current).
      const blocked = await failRequests(page, new RegExp(`/plan-versions/${v1.id}$`), "GET", "network");
      try {
        await weddingData.generatePlanVersion(w);
        await removePlanVersionAsPruningWould(v1.id);
      } finally {
        await blocked.clear();
      }
      await expect(planTab.versionRemovedNotice()).toBeVisible({ timeout: 10_000 });
      await expect(planTab.openVersionBadge(2)).toBeVisible();
    });

    await test.step("An older version opened from the list is removed: Restore opens the current plan instead", async () => {
      const v3 = await weddingData.generatePlanVersion(w);
      // Opened afresh (a reload lands on the Guests tab), so the version list includes version 3.
      await planTab.goto(w);
      await expect(planTab.openVersionBadge(3)).toBeVisible();
      await planTab.selectVersion(/^v2\b/);
      await expect(planTab.openVersionBadge(2)).toBeVisible();
      const v2 = (await weddingData.listPlanVersions(w)).find((v) => v.versionNumber === 2)!;
      expect(v3.id).not.toBe(v2.id);
      await removePlanVersionAsPruningWould(v2.id);
      await planTab.restoreButton(2).click();
      await expect(planTab.versionRemovedNotice()).toBeVisible();
      await expect(planTab.openVersionBadge(3)).toBeVisible();
      await expect(planTab.message(/Plan version not found/)).toHaveCount(0);
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.keeps-up-with-tables-removed-versions-and-split-groups.declined-guests-in-an-older-version",
    title: "an older version marks guests who have since been marked not attending instead of listing them as seated",
    objective:
      "Confirms that after a guest seated in version 1 is marked not attending and a version 2 is made, opening version 1 lists that guest as '<name> (not attending now)' rather than as an ordinary seat, and the server's version detail marks their seat notAttending.",
    expectedOutcome:
      "Version 1's list shows '<name> (not attending now)'; its detail has notAttending true on that guest's seat and on no other.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:day-of-mode", "@risk:low", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const decliner = uniquePersonName(testInfo.workerIndex);
    const declinerName = `${decliner.firstName} ${decliner.lastName}`;
    const declinerId = (await weddingData.createGuest(w, decliner)).id;
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "Main", capacity: 8 });
    const v1 = await weddingData.generatePlanVersion(w);
    await weddingData.generatePlanVersion(w);
    expect((await weddingData.setAttendance(w, declinerId, "NOT_ATTENDING")).status).toBe(200);

    const detail = await weddingData.getPlanVersionDetail(w, v1.id);
    const marked = detail.assignments.filter((a) => (a as { notAttending?: boolean }).notAttending);
    expect(marked.map((a) => a.guestId)).toEqual([declinerId]);

    const planTab = new PlanTabPage(page);
    await planTab.goto(w);
    await planTab.showListView();
    await planTab.selectVersion(/^v1\b/);
    await expect(planTab.notAttendingGuest(declinerName)).toBeVisible();
  },
);

defineQualityTest(
  {
    id: "seating-plan.keeps-up-with-tables-removed-versions-and-split-groups.undo-refuses-to-split-a-group",
    title: "undoing a move of a must-sit-together group that was split before it is refused instead of moving a partner to a table they were never at, and moves are announced",
    objective:
      "Confirms that when two guests who must sit together are at different tables (the rule was added after the plan was made), moving one to a third table (which takes both) is announced for screen readers, and that Undo then says 'Can't undo — that would split a must-sit-together group.' and leaves both guests at the third table.",
    expectedOutcome:
      "The announcement reads 'Moved <name> to Third.'. After Undo the refusal shows and both guests are still at 'Third' in the plan.",
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
    const tableOf = (guestId: string) => plan.assignments.find((x) => x.guestId === guestId)?.tableId;
    expect(tableOf(aId)).toBeTruthy();
    expect(tableOf(bId)).toBeTruthy();
    expect(tableOf(aId)).not.toBe(tableOf(bId));
    const third = await weddingData.createTable(w, { label: "Third", capacity: 4 });
    const rule = await context.request.post(`/api/v1/weddings/${w}/relationships`, {
      data: { guestAId: aId, guestBId: bId, type: "MUST_SIT_TOGETHER" },
    });
    expect(rule.status()).toBe(201);

    const planTab = new PlanTabPage(page);
    await planTab.goto(w);
    await planTab.showListView();

    await test.step("Moving one takes both to Third, and the move is announced", async () => {
      await planTab.moveGuestInList(aName, "Third");
      await expect(planTab.moveAnnouncement()).toHaveText(`Moved ${aName} to Third.`);
      const now = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(now.assignments.filter((x) => x.tableId === third.id).map((x) => x.guestId).sort()).toEqual([aId, bId].sort());
    });

    await test.step("Undo is refused -- the group was split before the move", async () => {
      await planTab.undo();
      await expect(planTab.message("Can't undo — that would split a must-sit-together group.")).toBeVisible();
      const now = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(now.assignments.filter((x) => x.tableId === third.id).map((x) => x.guestId).sort()).toEqual([aId, bId].sort());
    });
  },
);
