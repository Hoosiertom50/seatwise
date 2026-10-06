/**
 * TS-197 (REQ-DAY-OF-EMERGENCY-MODE, REQ-MANUAL-ADJUSTMENT) — Day-of mode keeps up with the
 * seating plan.
 * - A newer plan made elsewhere (another browser) shows up in an open Day-of tab on its own, within
 *   its 4-second check, with a note -- and moves made after that go to the new plan.
 * - A move sent to a plan that was just replaced is refused with the new plan attached: Day-of
 *   switches to it, says so, and the same move then works.
 * - "Move to…" offers only tables the guest's whole must-sit-together group fits at (party sizes
 *   added up, no Restricted table they aren't listed for), and moving one names everyone moved.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { failRequests } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "day-of-mode.keeps-up-with-new-plans-and-groups.newer-plan-shows-up-in-an-open-day-of-tab",
    title: "a newer plan made in another browser opens on its own in a Day-of tab that was already open, with a note, and the next move lands on it",
    objective:
      "Confirms (TS-197) that with Day-of mode open on version 1, generating a new plan from a second browser session makes Day-of switch to version 2 within its 4-second check, say 'A newer plan was made — you're now looking at it.', show where version 2 seats the guest, and send the next move to version 2.",
    expectedOutcome:
      "Within 10 seconds the note shows and the guest's row reads 'Seated at' version 2's table for them. Moving the guest to the other table puts them there in version 2 (version 1 is unchanged).",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, page }, testInfo) => {
    const w = managedWedding.id;
    const person = uniquePersonName(testInfo.workerIndex);
    const name = `${person.firstName} ${person.lastName}`;
    const guestId = (await weddingData.createGuest(w, person)).id;
    const alpha = await weddingData.createTable(w, { label: "Alpha", capacity: 4 });
    const bravo = await weddingData.createTable(w, { label: "Bravo", capacity: 4 });
    const v1 = await weddingData.generatePlanVersion(w);
    const v1TableId = v1.assignments.find((a) => a.guestId === guestId)?.tableId;

    const dayOf = new DayOfTabPage(page);
    await test.step("Day-of is open on version 1", async () => {
      await dayOf.goto(w);
      await expect(dayOf.guestStatusText(name)).toHaveText(/^Seated at (Alpha|Bravo)$/);
    });

    let v2Id = "";
    let v2TableId = "";
    const otherSession = await browser.newContext({ storageState: await context.storageState() });
    try {
      await test.step("Second browser session: generate a new plan", async () => {
        const res = await otherSession.request.post(`/api/v1/weddings/${w}/plan-versions/generate`);
        expect(res.status()).toBe(201);
        const body = (await res.json()) as { planVersion: { id: string; assignments: { guestId: string; tableId: string }[] } };
        v2Id = body.planVersion.id;
        v2TableId = body.planVersion.assignments.find((a) => a.guestId === guestId)!.tableId;
      });
    } finally {
      await otherSession.close();
    }

    const v2Label = v2TableId === alpha.id ? "Alpha" : "Bravo";
    const otherLabel = v2Label === "Alpha" ? "Bravo" : "Alpha";
    const otherId = v2Label === "Alpha" ? bravo.id : alpha.id;

    await test.step("Day-of switches to version 2 on its own and says so", async () => {
      await expect(dayOf.newerPlanNotice()).toBeVisible({ timeout: 10_000 });
      await expect(dayOf.guestStatusText(name)).toHaveText(`Seated at ${v2Label}`);
    });

    await test.step("The next move goes to version 2, not version 1", async () => {
      await dayOf.moveGuestTo(name, otherLabel);
      const v2 = await weddingData.getPlanVersionDetail(w, v2Id);
      expect(v2.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(otherId);
      const v1Now = await weddingData.getPlanVersionDetail(w, v1.id);
      expect(v1Now.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(v1TableId);
    });
  },
);

defineQualityTest(
  {
    id: "day-of-mode.keeps-up-with-new-plans-and-groups.a-move-on-a-replaced-plan-recovers",
    title: "a Day-of move sent to a plan that was just replaced is refused, Day-of switches to the new plan and says so, and the same move then works",
    objective:
      "Confirms (TS-197) that when a newer plan is made while Day-of still shows version 1 (its 4-second check is held off here so the move gets there first), moving a guest is refused without saving, the refusal carries the new current plan, Day-of switches to it with 'A newer plan was made — you're now looking at it.' and a row message, and moving the guest again succeeds on the new plan.",
    expectedOutcome:
      "After the refused move: the note shows, the guest's row reads 'Seated at Alpha' (the locked guest keeps their table in version 2) with \"That wasn't saved — a newer plan was made.\", and neither version has them at Bravo. After moving again: 'Seated at Bravo', and version 2 has them at Bravo.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE", "REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:manual-adjustment", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    // Locked, so the new plan keeps them at Alpha and the screen's answer is known in advance.
    const person = uniquePersonName(testInfo.workerIndex);
    const name = `${person.firstName} ${person.lastName}`;
    const guestId = (await weddingData.createGuest(w, { ...person, isLocked: true })).id;
    const alpha = await weddingData.createTable(w, { label: "Alpha", capacity: 4 });
    const bravo = await weddingData.createTable(w, { label: "Bravo", capacity: 4 });
    const v1 = await weddingData.generatePlanVersion(w);
    expect((await weddingData.moveGuestAssignment(w, v1.id, guestId, alpha.id)).status).toBe(200);

    const dayOf = new DayOfTabPage(page);
    await test.step("Day-of is open on version 1, and its 4-second check can't reach version 1", async () => {
      await dayOf.goto(w);
      await expect(dayOf.guestStatusText(name)).toHaveText("Seated at Alpha");
    });
    const blocked = await failRequests(page, new RegExp(`/plan-versions/${v1.id}$`), "GET", "network");

    let v2Id = "";
    await test.step("A newer plan is made elsewhere", async () => {
      const v2 = await weddingData.generatePlanVersion(w);
      v2Id = v2.id;
      expect(v2.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(alpha.id);
    });

    await test.step("The move is refused, and Day-of switches to the new plan and says so", async () => {
      await dayOf.startMoveGuestTo(name, "Bravo");
      await expect(dayOf.newerPlanNotice()).toBeVisible();
      await expect(dayOf.guestRowError(name)).toHaveText(/^That wasn't saved — a newer plan was made\./);
      await expect(dayOf.guestStatusText(name)).toHaveText("Seated at Alpha");
      for (const id of [v1.id, v2Id]) {
        const plan = await weddingData.getPlanVersionDetail(w, id);
        expect(plan.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(alpha.id);
      }
    });
    await blocked.clear();

    await test.step("The same move now works, on the new plan", async () => {
      await dayOf.moveGuestTo(name, "Bravo");
      const v2 = await weddingData.getPlanVersionDetail(w, v2Id);
      expect(v2.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(bravo.id);
    });
  },
);

defineQualityTest(
  {
    id: "day-of-mode.keeps-up-with-new-plans-and-groups.move-to-offers-only-tables-the-whole-group-fits",
    title: "Day-of 'Move to…' offers only tables the guest's whole must-sit-together group fits at, and the notice names everyone moved",
    objective:
      "Confirms (TS-197) that for a guest who must sit with a partner bringing a plus-one (a group needing 3 seats), Day-of's 'Move to…' list leaves out a table with 2 free seats (enough for the guest alone, which used to be offered and then refused) and a Restricted table they aren't listed for, offers the table with room for all three, and that moving there moves both guests and says so by name.",
    expectedOutcome:
      "The list offers only Charlie. After moving, both guests are at Charlie on the server and the notice reads 'Moved <guest> and <partner> to Charlie.'",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE", "REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:manual-adjustment", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const mover = uniquePersonName(testInfo.workerIndex);
    const partner = uniquePersonName(testInfo.workerIndex);
    const moverName = `${mover.firstName} ${mover.lastName}`;
    const partnerName = `${partner.firstName} ${partner.lastName}`;
    let moverId = "";
    let partnerId = "";
    let charlieId = "";

    await test.step("Arrange: a group of 3 at Alpha; Bravo has 2 seats; Charlie has 4; Delta is Restricted", async () => {
      moverId = (await weddingData.createGuest(w, mover)).id;
      partnerId = (await weddingData.createGuest(w, { ...partner, headcount: 2 })).id;
      await weddingData.createRelationship(w, moverId, partnerId, "MUST_SIT_TOGETHER");
      const alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 6 })).id;
      await weddingData.createTable(w, { label: "Bravo", capacity: 2 });
      charlieId = (await weddingData.createTable(w, { label: "Charlie", capacity: 4 })).id;
      await weddingData.createTable(w, { label: "Delta", capacity: 10, isRestricted: true });
      const plan = await weddingData.generatePlanVersion(w);
      expect((await weddingData.moveGuestAssignment(w, plan.id, moverId, alphaId)).status).toBe(200);
    });

    const dayOf = new DayOfTabPage(page);
    await test.step("The guest's Move to list offers only the table the whole group fits", async () => {
      await dayOf.goto(w);
      await expect(dayOf.guestStatusText(moverName)).toHaveText("Seated at Alpha");
      expect(await dayOf.moveToChoices(moverName)).toEqual(["Charlie"]);
    });

    await test.step("Moving the guest moves the group, and the notice names both", async () => {
      await dayOf.moveGuestTo(moverName, "Charlie");
      await expect(dayOf.noticeText()).toHaveText(`Moved ${moverName} and ${partnerName} to Charlie.`);
      const planId = (await weddingData.listPlanVersions(w)).find((v) => v.isCurrent)!.id;
      const plan = await weddingData.getPlanVersionDetail(w, planId);
      expect(plan.assignments.find((a) => a.guestId === moverId)?.tableId).toBe(charlieId);
      expect(plan.assignments.find((a) => a.guestId === partnerId)?.tableId).toBe(charlieId);
    });
  },
);
