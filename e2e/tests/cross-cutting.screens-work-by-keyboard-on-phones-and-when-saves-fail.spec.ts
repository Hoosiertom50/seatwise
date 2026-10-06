/**
 * TS-199 (and TS-195 item 3) — screens work by keyboard, on phones, and when saves fail:
 * - Back while typing in a box that saves when you leave it saves the box and leaves, without
 *   asking; with other unsaved input it still asks, and Stay puts focus back in that box.
 * - Arrowing through a "Move to…" list (Day-of) or a guest's RSVP list doesn't act on every value
 *   on the way: the move waits for the Move button, the RSVP for Enter. Focus comes back to the
 *   guest's list after a move.
 * - At 375px the notifications panel stays on the screen.
 * - A wedding setting that couldn't be saved keeps what was typed, says so, and still counts as
 *   unsaved.
 * - A collaborator's access level changed twice quickly ends with the last choice, on screen and
 *   on the server; arrowing through the list saves only when the list is left.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { failRequests, delayRequests, watchForRequest } from "../support/networkFaults.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { NotificationsBell } from "../components/NotificationsBell.js";

defineQualityTest(
  {
    id: "cross-cutting.screens-work-by-keyboard-on-phones-and-when-saves-fail.back-saves-a-box-that-saves-on-leaving",
    title: "Back while typing in a guest's name box saves it and leaves without asking; with a half-typed form it asks, and Stay puts focus back",
    objective:
      "Confirms (TS-199) that pressing the browser's Back button while typing in a guest row's first-name box (a box that saves when you leave it) saves the new name and goes back without the unsaved-changes question, and that with half-typed text in the add-guest form Back still asks and 'Stay on this tab' returns focus to that box.",
    expectedOutcome:
      "First Back: no question, the page is the dashboard, and the server has the new first name. Second Back (half-typed add-guest form): the question shows; after Stay the add-guest first-name box has focus.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const dashboard = new DashboardPage(page);
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    let guestId = "";

    await test.step("Arrange: a guest, and the wedding opened from the dashboard", async () => {
      guestId = (await weddingData.createGuest(w, name)).id;
      await dashboard.goto();
      await dashboard.weddingLink(managedWedding.name).click();
      await page.waitForURL(new RegExp(`/weddings/${w}$`));
      await guests.guestRow(fullName).expectVisible();
    });

    await test.step("Back while typing a new first name saves it and leaves without asking", async () => {
      await guests.guestRow(fullName).typeFirstNameWithoutLeaving("Backsaved");
      await wedding.goBackWithUnsavedInput();
      await page.waitForURL(/\/dashboard$/);
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await expect
        .poll(async () => (await weddingData.listGuests(w)).find((g) => g.id === guestId)?.firstName)
        .toBe("Backsaved");
    });

    await test.step("With a half-typed add-guest form, Back asks, and Stay puts focus back in that box", async () => {
      await dashboard.weddingLink(managedWedding.name).click();
      await page.waitForURL(new RegExp(`/weddings/${w}$`));
      await guests.typeNewGuestFirstName("Halfway");
      await wedding.goBackWithUnsavedInput();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
      await expect(wedding.focusedElement()).toHaveAttribute("id", "guest-first-name");
      expect(await guests.newGuestFirstName()).toBe("Halfway");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-work-by-keyboard-on-phones-and-when-saves-fail.arrow-keys-dont-act-until-confirmed",
    title: "arrowing through Day-of's Move to list doesn't move the guest -- the Move button does -- and arrowing through a guest's RSVP saves only on Enter",
    objective:
      "Confirms (TS-199) that in Day-of mode the Move button is off until a table is picked, that pressing the down arrow on a seated guest's Move to list leaves the guest where they are on the server, that picking Bravo and pressing Move seats them at Bravo and puts focus back on their list; and that on the Guests tab arrowing through a guest's RSVP list saves nothing until Enter, which saves the value shown.",
    expectedOutcome:
      "Move is disabled before a pick. After two down arrows the server still has the guest at Alpha and the row reads 'Seated at Alpha'. After Move they're at Bravo on the server and on screen, and their Move to list has focus. The RSVP stays Pending on the server after arrowing, and after Enter the server has the value the list shows (not Pending).",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE", "REQ-GUEST-LIST-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:guests", "@accessibility", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const mover = uniquePersonName(testInfo.workerIndex);
    const moverName = `${mover.firstName} ${mover.lastName}`;
    let moverId = "";
    let planVersionId = "";
    let alphaId = "";
    let bravoId = "";

    await test.step("Arrange: a guest at Alpha, with Bravo and Charlie empty", async () => {
      moverId = (await weddingData.createGuest(w, mover)).id;
      alphaId = (await weddingData.createTable(w, { label: "Alpha", capacity: 4 })).id;
      bravoId = (await weddingData.createTable(w, { label: "Bravo", capacity: 4 })).id;
      await weddingData.createTable(w, { label: "Charlie", capacity: 4 });
      planVersionId = (await weddingData.generatePlanVersion(w)).id;
      expect((await weddingData.moveGuestAssignment(w, planVersionId, moverId, alphaId)).status).toBe(200);
    });

    const dayOf = new DayOfTabPage(page);
    await test.step("The Move button is off until a table is picked, and arrowing moves nobody", async () => {
      await dayOf.goto(w);
      await expect(dayOf.guestStatusText(moverName)).toHaveText("Seated at Alpha");
      await expect(dayOf.moveButton(moverName)).toBeDisabled();
      const moveSent = watchForRequest(page, /\/assignments$/, "POST", 1500);
      await dayOf.arrowThroughMoveChoices(moverName, 2);
      expect(await moveSent, "no move is sent while arrowing").toBe(false);
      const detail = await weddingData.getPlanVersionDetail(w, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === moverId)?.tableId).toBe(alphaId);
      await expect(dayOf.guestStatusText(moverName)).toHaveText("Seated at Alpha");
    });

    await test.step("Picking Bravo and pressing Move moves them, and focus is back on their list", async () => {
      await dayOf.moveGuestTo(moverName, "Bravo");
      const detail = await weddingData.getPlanVersionDetail(w, planVersionId);
      expect(detail.assignments.find((a) => a.guestId === moverId)?.tableId).toBe(bravoId);
      await expect(dayOf.moveToList(moverName)).toBeFocused();
    });

    const guests = new WeddingGuestsPage(page);
    await test.step("Arrowing through the RSVP list saves nothing until Enter", async () => {
      await guests.goto(w);
      await guests.openGuestsTab();
      const row = guests.guestRow(moverName);
      await row.expectVisible();
      const rsvpSent = watchForRequest(page, new RegExp(`/guests/${moverId}$`), "PATCH", 1500);
      await row.arrowThroughRsvpStatus(2);
      expect(await rsvpSent, "no RSVP save is sent while arrowing").toBe(false);
      expect((await weddingData.listGuests(w)).find((g) => g.id === moverId)?.rsvpStatus).toBe("PENDING");
      const shown = await row.rsvpStatus();
      expect(shown).not.toBe("PENDING");
      await row.confirmRsvpStatusWithEnter();
      await expect.poll(async () => (await weddingData.listGuests(w)).find((g) => g.id === moverId)?.rsvpStatus).toBe(shown);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-work-by-keyboard-on-phones-and-when-saves-fail.bell-panel-stays-on-a-phone-screen",
    title: "at 375px the notifications panel opens fully on the screen, on the dashboard and on a wedding page",
    objective:
      "Confirms (TS-199) that on a 375px-wide screen, opening the notifications bell shows a panel whose left and right edges are both inside the screen, on the dashboard and on a wedding page.",
    expectedOutcome: "Both places: the panel's left edge is at or right of 0 and its right edge at or left of 375.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@readonly", "@feature:collaboration", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }) => {
    const bell = new NotificationsBell(page);
    const dashboard = new DashboardPage(page);
    const wedding = new WeddingDetailPage(page);
    await page.setViewportSize({ width: 375, height: 812 });
    for (const where of ["dashboard", "wedding page"] as const) {
      await test.step(`The panel is within the screen on the ${where}`, async () => {
        if (where === "dashboard") await dashboard.goto();
        else await wedding.goto(managedWedding.id);
        await bell.toggle();
        await expect(bell.panel()).toBeVisible();
        const box = (await bell.panel().boundingBox())!;
        expect(box.x, `${where}: left edge`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${where}: right edge`).toBeLessThanOrEqual(375);
        await bell.toggle();
      });
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-work-by-keyboard-on-phones-and-when-saves-fail.failed-setting-keeps-the-typing",
    title: "a wedding note that can't be saved keeps what was typed, says why, and still counts as unsaved",
    objective:
      "Confirms (TS-199) that when saving the wedding note on the Collaborators tab fails (server error), the note box keeps the typed text, the error is shown, the server keeps the old note, and switching tabs asks first because the note is still unsaved.",
    expectedOutcome:
      "After leaving the box: the error 'Simulated outage while saving the note.' shows, the box still reads the typed note, the server's note is unchanged, and clicking the Guests tab brings up the unsaved-changes question.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@feature:non-functional", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }) => {
    const w = managedWedding.id;
    const collaborators = new CollaboratorsTabPage(page);
    const wedding = new WeddingDetailPage(page);
    const before = (await weddingData.getWedding(w)).note ?? null;

    await test.step("A note save that fails keeps the typed note in the box", async () => {
      await collaborators.goto(w);
      const fault = await failRequests(page, new RegExp(`/api/v1/weddings/${w}$`), "PATCH", {
        status: 500,
        error: "Simulated outage while saving the note.",
      });
      await collaborators.setAndLeave(collaborators.weddingNoteInput(), "Typed while offline");
      await expect(collaborators.message("Simulated outage while saving the note.")).toBeVisible();
      await expect(collaborators.weddingNoteInput()).toHaveValue("Typed while offline");
      expect(fault.hits).toBeGreaterThanOrEqual(1);
      await fault.clear();
      expect((await weddingData.getWedding(w)).note ?? null).toBe(before);
    });

    await test.step("It still counts as unsaved: leaving the tab asks first", async () => {
      await wedding.clickTab("Guests");
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-work-by-keyboard-on-phones-and-when-saves-fail.access-level-changes-land-in-order",
    title: "a collaborator's access level changed twice quickly ends at the last choice; arrowing through it saves only when the list is left",
    objective:
      "Confirms (TS-195 item 3, TS-199) that with each save held back 700ms, changing a collaborator from Edit to Comment and then to View ends with View on screen and on the server, and that arrowing through the access-level list saves nothing until the list is left, which saves the value shown.",
    expectedOutcome:
      "After the two quick changes: the list shows View and the server has VIEW. After two arrow presses the server still has VIEW; after leaving the list the server has the value the list shows.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser }, testInfo) => {
    const w = managedWedding.id;
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "helper");
    const collaborators = new CollaboratorsTabPage(page);
    const serverLevel = async () =>
      (await weddingData.listCollaborators(w)).find((c) => c.userEmail === helper.email)?.permissionLevel;
    try {
      await weddingData.addCollaborator(w, helper.email, "EDIT");

      await test.step("Two quick changes end at the last one, on screen and on the server", async () => {
        await collaborators.goto(w);
        const slow = await delayRequests(page, /\/collaborators\/[^/]+$/, "PATCH", 700);
        await collaborators.setAccessLevel(helper.name, "Comment");
        await collaborators.setAccessLevel(helper.name, "View");
        await expect.poll(() => slow.hits, { timeout: 5_000 }).toBe(2);
        await expect.poll(serverLevel, { timeout: 10_000 }).toBe("VIEW");
        await expect(collaborators.accessLevelSelect(helper.name)).toHaveValue("VIEW");
        await slow.clear();
      });

      await test.step("Arrowing through the list saves only when the list is left", async () => {
        const levelSent = watchForRequest(page, /\/collaborators\/[^/]+$/, "PATCH", 1500);
        await collaborators.arrowThroughAccessLevel(helper.name, 2);
        expect(await levelSent, "no access-level save is sent while arrowing").toBe(false);
        expect(await serverLevel()).toBe("VIEW");
        const shown = await collaborators.accessLevelSelect(helper.name).inputValue();
        await collaborators.leaveAccessLevel(helper.name);
        await expect.poll(serverLevel).toBe(shown);
        await expect(collaborators.accessLevelSelect(helper.name)).toHaveValue(shown);
      });
    } finally {
      await helper.context.close();
    }
  },
);
