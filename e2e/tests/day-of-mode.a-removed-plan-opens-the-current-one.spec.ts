/**
 * TS-221 (REQ-DAY-OF-EMERGENCY-MODE) — Day-of mode when the plan it has open is removed (older
 * versions are pruned once a wedding has many: the plan open here can stop being current and be
 * removed in the same moment). Its 4-second check swallowed the 404, so the screen stayed on the
 * removed plan and every seat or swap said "Plan version not found". Now Day-of opens the current
 * plan and says why -- from its check, or from a change that found the plan gone.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { failRequests } from "../support/networkFaults.js";
import { removePlanVersionAsPruningWould } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "day-of-mode.a-removed-plan-opens-the-current-one.from-the-check-and-from-a-move",
    title: "Day-of opens the current plan, with a note, when the plan it has open is removed -- found by its 4-second check or by a move",
    objective:
      "Confirms that when the plan open in Day-of is replaced and removed before its next check sees it, Day-of opens the current plan and says 'The plan you had open was removed — you're now looking at the current plan.'; and that a move sent to a removed plan is refused with 'That wasn't saved — the plan you had open was removed…' in the guest's row while Day-of opens the current plan, after which the same move works.",
    expectedOutcome:
      "The removed-plan note shows within 10 seconds and the guest's row shows the new plan's table. The move on the removed plan shows the row message and the note; repeating it moves the guest in the current plan.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const person = uniquePersonName(testInfo.workerIndex);
    const name = `${person.firstName} ${person.lastName}`;
    const guestId = (await weddingData.createGuest(w, person)).id;
    const alpha = await weddingData.createTable(w, { label: "Alpha", capacity: 4 });
    const bravo = await weddingData.createTable(w, { label: "Bravo", capacity: 4 });
    const v1 = await weddingData.generatePlanVersion(w);
    const dayOf = new DayOfTabPage(page);
    await dayOf.goto(w);
    await expect(dayOf.guestStatusText(name)).toHaveText(/^Seated at (Alpha|Bravo)$/);

    let v2Id = "";
    await test.step("Replaced and removed between two checks: the current plan opens, with a note", async () => {
      // Day-of's checks of version 1 fail while it is replaced and removed, so the next real check
      // finds it gone (rather than merely no longer current).
      const blocked = await failRequests(page, new RegExp(`/plan-versions/${v1.id}$`), "GET", "network");
      try {
        v2Id = (await weddingData.generatePlanVersion(w)).id;
        await removePlanVersionAsPruningWould(v1.id);
      } finally {
        await blocked.clear();
      }
      await expect(dayOf.planRemovedNotice()).toBeVisible({ timeout: 10_000 });
      const v2 = await weddingData.getPlanVersionDetail(w, v2Id);
      const v2Label = v2.assignments.find((a) => a.guestId === guestId)?.tableId === alpha.id ? "Alpha" : "Bravo";
      await expect(dayOf.guestStatusText(name)).toHaveText(`Seated at ${v2Label}`);
    });

    await test.step("A move sent to a removed plan says so, Day-of opens the current plan, and the move then works", async () => {
      // Version 2 is replaced and removed with Day-of's checks held off, so the move is the first to find out.
      const blocked = await failRequests(page, new RegExp(`/plan-versions/${v2Id}$`), "GET", "network");
      let v3Id = "";
      try {
        v3Id = (await weddingData.generatePlanVersion(w)).id;
        await removePlanVersionAsPruningWould(v2Id);
        // Day-of still shows version 2 -- the move offers the table they aren't at there.
        const target = (await dayOf.guestStatusText(name).textContent())?.includes("Alpha") ? "Bravo" : "Alpha";
        await dayOf.startMoveGuestTo(name, target);
        await expect(dayOf.guestRowError(name)).toContainText("the plan you had open was removed");
      } finally {
        await blocked.clear();
      }
      await expect(dayOf.planRemovedNotice()).toBeVisible();
      const v3 = await weddingData.getPlanVersionDetail(w, v3Id);
      const targetLabel = v3.assignments.find((a) => a.guestId === guestId)?.tableId === alpha.id ? "Bravo" : "Alpha";
      const targetId = targetLabel === "Alpha" ? alpha.id : bravo.id;
      await dayOf.moveGuestTo(name, targetLabel);
      const after = await weddingData.getPlanVersionDetail(w, v3Id);
      expect(after.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(targetId);
    });
  },
);
