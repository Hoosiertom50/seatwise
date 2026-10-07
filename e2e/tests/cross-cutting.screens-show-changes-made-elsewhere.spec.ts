/**
 * TS-207 (REQ-NON-FUNCTIONAL, REQ-DAY-OF-EMERGENCY-MODE, REQ-GUEST-LIST-MANAGEMENT,
 * REQ-MANUAL-ADJUSTMENT) — screens show guest, table and rule changes made elsewhere, without a
 * reload.
 * - Day-of on two screens: a walk-in added on one shows up on the other; a guest who declines by
 *   their RSVP link shows "Not attending"; a table given more seats is offered in "Move to…".
 * - "Mark not attending" on someone already marked not attending elsewhere says so, rather than
 *   claiming it just did it.
 * - The Seating plan tab names a guest added elsewhere -- never their id -- even before its own
 *   guest list has them.
 * - The Guests tab shows another person's edit to a guest.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { failRequests } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "cross-cutting.screens-show-changes-made-elsewhere.day-of-on-two-screens-keeps-up",
    title: "Day-of on two screens: a walk-in added on one appears on the other, a decline by RSVP link shows Not attending, and a table given more seats is offered in Move to",
    objective:
      "Confirms (TS-207) that with Day-of open on two pages of one wedding, a walk-in added on page A shows in page B's guest list within its 4-second check; a guest who declines through their RSVP link reads 'Not attending' on page B; and after a full table is given more seats (from the Tables API), page B's 'Move to…' list for a guest whose list said 'No other table has room' offers that table -- all without reloading page B.",
    expectedOutcome:
      "Within 10 seconds each: page B lists the walk-in; the declining guest's row reads 'Not attending'; the mover's Move to list offers Bravo.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:day-of-mode", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, page }, testInfo) => {
    const w = managedWedding.id;
    const mover = uniquePersonName(testInfo.workerIndex);
    const filler = uniquePersonName(testInfo.workerIndex);
    const decliner = uniquePersonName(testInfo.workerIndex);
    const moverName = `${mover.firstName} ${mover.lastName}`;
    const declinerName = `${decliner.firstName} ${decliner.lastName}`;
    const walkIn = uniquePersonName(testInfo.workerIndex);
    const walkInName = `${walkIn.firstName} ${walkIn.lastName}`;
    let bravoId = "";
    let declinerId = "";

    await test.step("Arrange: Alpha (2 seats) has the mover and the decliner; Bravo (1 seat) is full", async () => {
      const moverId = (await weddingData.createGuest(w, mover)).id;
      const fillerId = (await weddingData.createGuest(w, filler)).id;
      declinerId = (await weddingData.createGuest(w, decliner)).id;
      const alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 2 })).id;
      bravoId = (await weddingData.createTable(w, { label: "Bravo", capacity: 1 })).id;
      const plan = await weddingData.generatePlanVersion(w);
      for (const id of [moverId, fillerId, declinerId]) {
        expect((await weddingData.moveGuestAssignment(w, plan.id, id, null)).status).toBe(200);
      }
      expect((await weddingData.moveGuestAssignment(w, plan.id, moverId, alphaId)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, plan.id, declinerId, alphaId)).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, plan.id, fillerId, bravoId)).status).toBe(200);
    });

    const pageB = await context.newPage();
    const dayOfA = new DayOfTabPage(page);
    const dayOfB = new DayOfTabPage(pageB);
    await test.step("Both pages open Day-of; page B's mover has nowhere to go", async () => {
      await dayOfA.goto(w);
      await dayOfB.goto(w);
      await expect(dayOfB.guestStatusText(moverName)).toHaveText("Seated at Alpha");
      expect(await dayOfB.moveToChoices(moverName)).toEqual([]);
    });

    await test.step("A walk-in added on page A shows up on page B", async () => {
      await dayOfA.addWalkIn(walkIn.firstName, walkIn.lastName);
      await expect(dayOfB.guestRowLocator(walkInName)).toBeVisible({ timeout: 10_000 });
    });

    await test.step("A guest who declines by their RSVP link reads Not attending on page B", async () => {
      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${declinerId}/rsvp-link`, { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const visitor = await browser.newContext();
      try {
        const res = await visitor.request.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "DECLINED" } });
        expect(res.status()).toBe(200);
      } finally {
        await visitor.close();
      }
      await expect(dayOfB.guestStatusText(declinerName)).toHaveText("Not attending", { timeout: 10_000 });
    });

    await test.step("Bravo given more seats elsewhere is offered in page B's Move to list", async () => {
      await weddingData.updateTable(w, bravoId, { capacity: 3 });
      await expect.poll(() => dayOfB.moveToChoices(moverName), { timeout: 10_000 }).toEqual(["Bravo"]);
    });
    await pageB.close();
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-show-changes-made-elsewhere.mark-not-attending-twice-says-so",
    title: "Mark not attending on a guest already marked not attending elsewhere says so instead of claiming it",
    objective:
      "Confirms (TS-207) that when Day-of's guest list is out of date (its refresh is held off here) and the guest was marked not attending elsewhere, pressing 'Mark not attending' doesn't claim to have done it: the notice says they were already marked not attending, and the row then reads 'Not attending'.",
    expectedOutcome:
      "The notice reads '<guest> was already marked not attending (changed elsewhere).' and the row reads 'Not attending'.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const person = uniquePersonName(testInfo.workerIndex);
    const name = `${person.firstName} ${person.lastName}`;
    const guestId = (await weddingData.createGuest(w, person)).id;
    await weddingData.createTable(w, { label: "Alpha", capacity: 4 });
    await weddingData.generatePlanVersion(w);

    const dayOf = new DayOfTabPage(page);
    await dayOf.goto(w);
    await expect(dayOf.guestStatusText(name)).toHaveText("Seated at Alpha");
    // The page's guest list can't refresh, so it still shows them attending.
    const held = await failRequests(page, new RegExp(`/api/v1/weddings/${w}/guests$`), "GET", "network");
    expect((await weddingData.setAttendance(w, guestId, "NOT_ATTENDING")).status).toBe(200);

    await test.step("Pressing Mark not attending says they already were", async () => {
      await dayOf.attendanceButtonLocator(name).click();
      await expect(dayOf.noticeText()).toHaveText(`${name} was already marked not attending (changed elsewhere).`);
      await expect(dayOf.guestStatusText(name)).toHaveText("Not attending");
    });
    await held.clear();
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-show-changes-made-elsewhere.plan-tab-names-a-guest-added-elsewhere",
    title: "the Seating plan tab names a guest added elsewhere -- never their id -- even before its own guest list has them",
    objective:
      "Confirms (TS-207) that with the Seating plan tab open and its guest list unable to refresh (held off here), a guest added from elsewhere (they join the current plan unseated) appears in 'Unassigned guests' by name within the plan's 4-second check, using the names the plan itself now carries -- and that the guest's id is never shown, nor used in the Seat button's name.",
    expectedOutcome:
      "Within 10 seconds the Unassigned area shows the new guest's full name, not their id, and a 'Seat <name>' button exists.",
    requirementIds: ["REQ-MANUAL-ADJUSTMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "Alpha", capacity: 4 });
    await weddingData.generatePlanVersion(w);

    const plan = new PlanTabPage(page);
    await plan.goto(w);
    await expect(plan.seatedSummary()).toHaveText("1 seated, 0 unassigned");
    const held = await failRequests(page, new RegExp(`/api/v1/weddings/${w}/guests$`), "GET", "network");

    const late = uniquePersonName(testInfo.workerIndex);
    const lateName = `${late.firstName} ${late.lastName}`;
    const lateId = (await weddingData.createGuest(w, late)).id;

    await test.step("The new guest is listed by name, never by id", async () => {
      await expect(plan.unassignedArea()).toContainText(lateName, { timeout: 10_000 });
      await expect(plan.unassignedArea()).not.toContainText(lateId);
      await expect(plan.listMoveButtonFor(lateName)).toHaveText("Seat");
    });
    await held.clear();
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-show-changes-made-elsewhere.guests-tab-shows-edits-made-elsewhere",
    title: "the Guests tab shows a guest added elsewhere and another person's edit to a guest without a reload",
    objective:
      "Confirms (TS-207) that with the Guests tab open, a guest added through the API (as another planner or an import would) appears in the list, and a guest renamed elsewhere shows the new name -- each within the page's 4-second check.",
    expectedOutcome: "Within 10 seconds the new guest's first-name box and the renamed guest's new first name are on the page.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    const w = managedWedding.id;
    const first = uniquePersonName(testInfo.workerIndex);
    const firstId = (await weddingData.createGuest(w, first)).id;

    const guests = new WeddingGuestsPage(page);
    await guests.goto(w);
    await expect(guests.guestRow(`${first.firstName} ${first.lastName}`).firstNameBox()).toHaveValue(first.firstName);

    await test.step("A guest added elsewhere appears", async () => {
      const added = uniquePersonName(testInfo.workerIndex);
      await weddingData.createGuest(w, added);
      await expect(guests.guestRow(`${added.firstName} ${added.lastName}`).locator()).toBeVisible({ timeout: 10_000 });
    });

    await test.step("A guest renamed elsewhere shows the new name", async () => {
      const current = ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${firstId}`)).json()) as {
        guest: { revision: number };
      }).guest;
      const res = await context.request.patch(`/api/v1/weddings/${w}/guests/${firstId}`, {
        data: { firstName: "Renamed", expectedRevision: current.revision },
      });
      expect(res.status()).toBe(200);
      await expect(guests.guestRow(`Renamed ${first.lastName}`).firstNameBox()).toHaveValue("Renamed", { timeout: 10_000 });
    });
  },
);
