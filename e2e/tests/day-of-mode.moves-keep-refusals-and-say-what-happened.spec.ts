/**
 * TS-208 (REQ-DAY-OF-EMERGENCY-MODE, REQ-MANUAL-ADJUSTMENT, REQ-EXPORT-PRINT-RESTORE) — Day-of
 * and Seating plan moves say what really happened.
 * - A refused Day-of move stays on screen when a second change, queued behind it, goes through.
 * - Undo of seating a guest whose must-sit-together partner was already at that table unseats
 *   only that guest.
 * - Day-of "Move to…" leaves out a table where someone the guest must not sit with is seated.
 * - Day-of "Seat" says who was seated, and names a partner it moved along.
 * - A wedding with no guests says "No guests yet." on Day-of.
 * - A nickname saved just after someone else's Generate opens the new plan, with the notice.
 * - A restore preview gives a reason for a guest whose table has since been removed, and says
 *   when the restore will be saved as a comparison draft.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { delayRequests, failRequests } from "../support/networkFaults.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "day-of-mode.moves-keep-refusals-and-say-what-happened.a-queued-move-never-hides-a-refusal",
    title: "Day-of: a refused move stays on screen when a second move, queued behind it, goes through",
    objective:
      "Confirms (TS-208) that with Day-of's moves slowed down, moving guest A to Bravo (refused: a 'must not sit together' rule made elsewhere, which this screen hasn't loaded yet) and straight away moving guest B to Charlie shows both outcomes: A's row keeps the refusal, and the notice says B was moved. Before, the second move wiped the first one's refusal as it started, so the failed move looked done.",
    expectedOutcome:
      "A's row shows the 'must not sit together' refusal and A is still at Alpha; the notice reads 'Moved <B> to Charlie.' and B is at Charlie on the server.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const a = uniquePersonName(testInfo.workerIndex);
    const b = uniquePersonName(testInfo.workerIndex);
    const enemy = uniquePersonName(testInfo.workerIndex);
    const aName = `${a.firstName} ${a.lastName}`;
    const bName = `${b.firstName} ${b.lastName}`;
    let aId = "";
    let bId = "";
    let enemyId = "";
    let alphaId = "";
    let charlieId = "";
    let planId = "";

    await test.step("Arrange: A and B at Alpha, someone at Bravo, Charlie empty", async () => {
      aId = (await weddingData.createGuest(w, a)).id;
      bId = (await weddingData.createGuest(w, b)).id;
      enemyId = (await weddingData.createGuest(w, enemy)).id;
      alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 4 })).id;
      const bravoId = (await weddingData.createTable(w, { label: "Bravo", capacity: 4 })).id;
      charlieId = (await weddingData.createTable(w, { label: "Charlie", capacity: 4 })).id;
      planId = (await weddingData.generatePlanVersion(w)).id;
      expect((await weddingData.moveGuestAssignment(w, planId, aId, alphaId)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, planId, bId, alphaId)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, planId, enemyId, bravoId)).status).toBe(200);
    });

    const dayOf = new DayOfTabPage(page);
    await dayOf.goto(w);
    await expect(dayOf.guestStatusText(aName)).toHaveText("Seated at Alpha");
    await expect(dayOf.guestStatusText(bName)).toHaveText("Seated at Alpha");
    // This screen can't load the new rule, so it still offers Bravo for A.
    const rulesHeld = await failRequests(page, new RegExp(`/api/v1/weddings/${w}/relationships$`), "GET", "network");
    await weddingData.createRelationship(w, aId, enemyId, "MUST_NOT_SIT_TOGETHER");
    const slow = await delayRequests(page, "**/assignments", "POST", 800);

    await test.step("Move A to Bravo, then straight away B to Charlie", async () => {
      await dayOf.startMoveGuestTo(aName, "Bravo");
      await dayOf.startMoveGuestTo(bName, "Charlie");
    });

    await test.step("A's refusal stays, and B's move is reported", async () => {
      await expect(dayOf.noticeText()).toHaveText(`Moved ${bName} to Charlie.`, { timeout: 10_000 });
      await expect(dayOf.guestRowError(aName)).toContainText("must not sit together");
      await expect(dayOf.guestStatusText(aName)).toHaveText("Seated at Alpha");
      const plan = await weddingData.getPlanVersionDetail(w, planId);
      expect(plan.assignments.find((x) => x.guestId === aId)?.tableId).toBe(alphaId);
      expect(plan.assignments.find((x) => x.guestId === bId)?.tableId).toBe(charlieId);
    });
    await slow.clear();
    await rulesHeld.clear();
  },
);

defineQualityTest(
  {
    id: "day-of-mode.moves-keep-refusals-and-say-what-happened.move-hides-must-not-table-and-seat-announces",
    title: "Day-of: Move to leaves out a table with someone the guest must not sit with; Seat says who was seated and names a partner moved along",
    objective:
      "Confirms (TS-208) that Day-of's 'Move to…' list for a guest leaves out the table where someone they must not sit with is seated; that 'Seat at…' offers tables with their free seats; that seating a guest whose must-sit partner is already at that table announces 'Seated <guest> at <table>.'; and that seating a guest whose partner sits at another table announces 'Moved <guest> and <partner> to <table>.'.",
    expectedOutcome:
      "Move to offers only Charlie. Seat at offers Alpha, Bravo and Charlie with free seats. The notices read 'Seated <A> at Alpha.' and 'Moved <C> and <D> to Charlie.'.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE", "REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:manual-adjustment", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const people = Array.from({ length: 6 }, () => uniquePersonName(testInfo.workerIndex));
    const [mover, enemy, a, b, c, d] = people;
    const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;

    await test.step("Arrange", async () => {
      const alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 6 })).id;
      const bravoId = (await weddingData.createTable(w, { label: "Bravo", capacity: 6 })).id;
      await weddingData.createTable(w, { label: "Charlie", capacity: 6 });
      const moverId = (await weddingData.createGuest(w, mover)).id;
      const enemyId = (await weddingData.createGuest(w, enemy)).id;
      const bId = (await weddingData.createGuest(w, b)).id;
      const cId = (await weddingData.createGuest(w, c)).id;
      const planId = (await weddingData.generatePlanVersion(w)).id;
      expect((await weddingData.moveGuestAssignment(w, planId, moverId, alphaId)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, planId, enemyId, bravoId)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, planId, bId, alphaId)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, planId, cId, bravoId)).status).toBe(200);
      await weddingData.createRelationship(w, moverId, enemyId, "MUST_NOT_SIT_TOGETHER");
      // A and D join after the plan was made, so they start unseated; then each gets a must-sit partner.
      const aId = (await weddingData.createGuest(w, a)).id;
      const dId = (await weddingData.createGuest(w, d)).id;
      await weddingData.createRelationship(w, aId, bId, "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(w, dId, cId, "MUST_SIT_TOGETHER");
    });

    const dayOf = new DayOfTabPage(page);
    await dayOf.goto(w);
    await expect(dayOf.guestStatusText(nameOf(mover))).toHaveText("Seated at Alpha");

    await test.step("Move to leaves out Bravo, where the guest's must-not partner sits", async () => {
      expect(await dayOf.moveToChoices(nameOf(mover))).toEqual(["Charlie"]);
    });

    await test.step("Seat at lists tables with their free seats", async () => {
      expect(await dayOf.seatAtChoices(nameOf(a))).toEqual(["Alpha", "Bravo", "Charlie"]);
    });

    await test.step("Seating A beside partner B (already at Alpha) says so", async () => {
      await dayOf.seatGuestAt(nameOf(a), "Alpha");
      await expect(dayOf.noticeText()).toHaveText(`Seated ${nameOf(a)} at Alpha.`);
      await expect(dayOf.guestStatusText(nameOf(a))).toHaveText("Seated at Alpha");
    });

    await test.step("Seating D at Charlie moves partner C along, and says so", async () => {
      await dayOf.seatGuestAt(nameOf(d), "Charlie");
      await expect(dayOf.noticeText()).toHaveText(`Moved ${nameOf(d)} and ${nameOf(c)} to Charlie.`);
      await expect(dayOf.guestStatusText(nameOf(c))).toHaveText("Seated at Charlie");
    });
  },
);

defineQualityTest(
  {
    id: "day-of-mode.moves-keep-refusals-and-say-what-happened.no-guests-yet",
    title: "Day-of: a wedding with no guests says 'No guests yet.'",
    objective:
      "Confirms (TS-208) that Day-of on a wedding with no guests says 'No guests yet.' -- it used to read 'No guests match “”.' -- and that a search with no results still says 'No guests match'.",
    expectedOutcome: "'No guests yet.' shows and no 'No guests match' line; after adding a guest and searching 'zzzz', 'No guests match' shows.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@risk:low", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const dayOf = new DayOfTabPage(page);
    await dayOf.goto(w);
    await expect(dayOf.noGuestsYetMessage()).toBeVisible();
    await expect(dayOf.noSearchMatchMessage()).toHaveCount(0);

    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await dayOf.goto(w);
    await dayOf.search("zzzz-nobody");
    await expect(dayOf.noSearchMatchMessage()).toBeVisible();
    await expect(dayOf.noGuestsYetMessage()).toHaveCount(0);
  },
);

defineQualityTest(
  {
    id: "day-of-mode.moves-keep-refusals-and-say-what-happened.undo-of-seat-keeps-the-partner-seated",
    title: "Seating plan: undo of seating a guest next to their must-sit partner unseats only that guest",
    objective:
      "Confirms (TS-208) that on the Seating plan tab, seating unseated guest A at Alpha -- where A's must-sit-together partner B already sits -- and pressing Undo takes away only A's seat; B stays at Alpha. Before, undo unseated B too.",
    expectedOutcome: "After Seat: A and B at Alpha. After Undo: A has no seat, B is still at Alpha.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const a = uniquePersonName(testInfo.workerIndex);
    const b = uniquePersonName(testInfo.workerIndex);
    const aName = `${a.firstName} ${a.lastName}`;
    let aId = "";
    let bId = "";
    let alphaId = "";
    let planId = "";

    await test.step("Arrange: B at Alpha; A (added later, unseated) must sit with B", async () => {
      bId = (await weddingData.createGuest(w, b)).id;
      alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 4 })).id;
      await weddingData.createTable(w, { label: "Bravo", capacity: 4 });
      planId = (await weddingData.generatePlanVersion(w)).id;
      expect((await weddingData.moveGuestAssignment(w, planId, bId, alphaId)).status).toBe(200);
      aId = (await weddingData.createGuest(w, a)).id;
      await weddingData.createRelationship(w, aId, bId, "MUST_SIT_TOGETHER");
    });

    const plan = new PlanTabPage(page);
    await plan.goto(w);
    await expect(plan.unassignedArea()).toContainText(aName);

    await test.step("Seat A at Alpha", async () => {
      await plan.moveGuestInList(aName, "Alpha");
      const detail = await weddingData.getPlanVersionDetail(w, planId);
      expect(detail.assignments.find((x) => x.guestId === aId)?.tableId).toBe(alphaId);
      expect(detail.assignments.find((x) => x.guestId === bId)?.tableId).toBe(alphaId);
    });

    await test.step("Undo unseats only A", async () => {
      await plan.undo();
      await expect(plan.unassignedArea()).toContainText(aName);
      const detail = await weddingData.getPlanVersionDetail(w, planId);
      expect(detail.assignments.find((x) => x.guestId === aId)).toBeUndefined();
      expect(detail.assignments.find((x) => x.guestId === bId)?.tableId).toBe(alphaId);
    });
  },
);

defineQualityTest(
  {
    id: "day-of-mode.moves-keep-refusals-and-say-what-happened.nickname-racing-generate-opens-the-new-plan",
    title: "Seating plan: a nickname saved just after someone else's Generate opens the new plan, with the notice",
    objective:
      "Confirms (TS-208) that when a newer plan is made elsewhere while the Seating plan tab still shows version 1 (its 4-second check is held off here, so the save gets there first), saving a nickname for version 1 is refused as out of date and the tab then opens version 2 and says 'A newer plan was made — you're now looking at it.' -- instead of staying on version 1 with its check stopped and no word.",
    expectedOutcome: "The newer-plan notice shows and the open version badge reads 'Version 2'.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT", "REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "Alpha", capacity: 4 });
    const v1 = await weddingData.generatePlanVersion(w);

    const plan = new PlanTabPage(page);
    await plan.goto(w);
    await expect(plan.openVersionBadge(1)).toBeVisible();
    const held = await failRequests(page, new RegExp(`/plan-versions/${v1.id}$`), "GET", "network");
    await weddingData.generatePlanVersion(w);

    await test.step("Saving a nickname on version 1 opens version 2 with the notice", async () => {
      await plan.setNickname("Family draft");
      await expect(plan.newerPlanNotice()).toBeVisible({ timeout: 10_000 });
      await expect(plan.openVersionBadge(2)).toBeVisible();
    });
    await held.clear();
  },
);

defineQualityTest(
  {
    id: "day-of-mode.moves-keep-refusals-and-say-what-happened.restore-preview-explains-and-warns-of-a-draft",
    title: "Restore preview: a guest whose table was removed gets a reason, and an Edit collaborator is told before confirming that it will be a comparison draft",
    objective:
      "Confirms (TS-208) that after the table a guest sat at in version 1 is removed, version 1's restore preview lists that guest with a reason (the seat went with the table, so it used to give none), and that for an Edit collaborator on an approved current plan the preview answers willSaveAsDraft and the Seating plan tab says before confirming that the restore will be saved as a comparison draft (for the owner it doesn't).",
    expectedOutcome:
      "The preview's droppedGuests includes the guest with a reason mentioning their table being removed; owner preview willSaveAsDraft false; collaborator preview willSaveAsDraft true and the tab shows the comparison-draft note.",
    requirementIds: ["REQ-EXPORT-PRINT-RESTORE", "REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:export", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const guest = uniquePersonName(testInfo.workerIndex);
    const guestId = (await weddingData.createGuest(w, guest)).id;
    const alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 4 })).id;
    await weddingData.createTable(w, { label: "Bravo", capacity: 4 });
    const v1 = await weddingData.generatePlanVersion(w);
    expect((await weddingData.moveGuestAssignment(w, v1.id, guestId, alphaId)).status).toBe(200);
    const v2 = await weddingData.generatePlanVersion(w);
    expect((await weddingData.moveGuestAssignment(w, v2.id, guestId, null)).status).toBe(200);
    // Removing Alpha takes version 1's seat at it too.
    expect((await context.request.delete(api(`tables/${alphaId}`))).status()).toBe(200);

    await test.step("The preview gives the guest a reason", async () => {
      const res = await context.request.get(api(`plan-versions/${v1.id}/restore-preview`));
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        preview: { droppedGuests: { guestId: string; reason: string }[]; unassignedGuestIds: string[] };
        willSaveAsDraft: boolean;
      };
      expect(body.preview.unassignedGuestIds).toContain(guestId);
      expect(body.preview.droppedGuests.find((d) => d.guestId === guestId)?.reason).toContain("table has since been removed");
      expect(body.willSaveAsDraft).toBe(false);
    });

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    try {
      await weddingData.addCollaborator(w, editor.email, "EDIT");
      expect((await weddingData.moveGuestAssignment(w, v2.id, guestId, (await weddingData.listTables(w))[0].id)).status).toBe(200);
      expect((await weddingData.setPlanVersionStatus(w, v2.id, "IN_REVIEW")).status).toBe(200);
      expect((await weddingData.setPlanVersionStatus(w, v2.id, "APPROVED")).status).toBe(200);

      await test.step("An Edit collaborator is told before confirming that it will be a comparison draft", async () => {
        const res = await editor.context.request.get(api(`plan-versions/${v1.id}/restore-preview`));
        expect(((await res.json()) as { willSaveAsDraft: boolean }).willSaveAsDraft).toBe(true);
        const editorPage = await editor.context.newPage();
        const plan = new PlanTabPage(editorPage);
        await plan.goto(w);
        await plan.selectVersion(new RegExp(`^v${v1.versionNumber}\\b`));
        await plan.restoreButton(v1.versionNumber).click();
        await expect(plan.restoreWillBeDraftNote()).toBeVisible();
        await editorPage.close();
      });
    } finally {
      await editor.context.close();
    }
  },
);
