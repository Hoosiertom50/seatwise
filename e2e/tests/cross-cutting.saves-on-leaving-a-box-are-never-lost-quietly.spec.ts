/**
 * TS-206 (REQ-NON-FUNCTIONAL, REQ-GUEST-LIST-MANAGEMENT) — a box that saves when you leave it never
 * loses the typing without a word:
 * - Back while typing a name the server refuses (or with the connection down) stays on the page,
 *   keeps the typing in the box with the reason, and asks the usual question -- it used to leave
 *   before the save answered.
 * - A guest's email save that fails after the Guests tab was closed shows "Couldn't save <name>'s
 *   email: <reason>" near the tabs, and no tab click asks about unsaved changes afterwards -- it used
 *   to leave a phantom "unsaved" mark behind for good.
 * - The header never says "All changes saved" after Dismiss, or while a failed change is still
 *   unsaved in its box.
 * Server answers are failed or held on purpose (support/networkFaults.ts) so the timing is the same
 * on every run.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { delayThenFailRequests, failRequests } from "../support/networkFaults.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";

const GUEST_PATCH = (guestId: string) => new RegExp(`/api/v1/weddings/[^/]+/guests/${guestId}$`);

defineQualityTest(
  {
    id: "cross-cutting.saves-on-leaving-a-box-are-never-lost-quietly.back-waits-for-the-save",
    title: "Back while typing a refused name (or with no connection) stays on the page, keeps the typing and the reason, and asks first",
    objective:
      "Confirms (TS-206) that pressing the browser's Back button while a guest's first-name box holds 'J0hn' -- which the server refuses with a 422 -- waits for that save, stays on the wedding page, shows the reason on the row with 'J0hn' still in the box, and asks the unsaved-changes question (Stay puts focus back in the box); and that the same happens when the connection is down.",
    expectedOutcome:
      "After each Back the address is still the wedding page, the question is showing, the row shows the refusal (or 'Not saved yet'), the box still says what was typed, and the server still has the old first name. After Stay the first-name box has focus.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const dashboard = new DashboardPage(page);
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    let guestId = "";

    await test.step("Arrange: a guest, and the wedding opened from the dashboard (so Back has somewhere to go)", async () => {
      guestId = (await weddingData.createGuest(w, name)).id;
      await dashboard.goto();
      await dashboard.weddingLink(managedWedding.name).click();
      await page.waitForURL(new RegExp(`/weddings/${w}$`));
      await guests.guestRow(fullName).expectVisible();
    });

    await test.step("A refused name: Back stays, keeps 'J0hn' and the reason, and asks", async () => {
      const refusal = "First name can only use letters, spaces, hyphens and apostrophes.";
      const refuse = await failRequests(page, GUEST_PATCH(guestId), "PATCH", { status: 422, error: refusal });
      const row = guests.guestRow(fullName);
      await row.typeFirstNameWithoutLeaving("J0hn");
      await wedding.goBackWithUnsavedInput();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/weddings/${w}$`));
      await expect(row.locator().getByText(refusal)).toBeVisible();
      await expect(row.firstNameBox()).toHaveValue("J0hn");
      expect(refuse.hits).toBe(1);
      expect((await weddingData.listGuests(w)).find((g) => g.id === guestId)?.firstName).toBe(name.firstName);
      await wedding.stayOnTab();
      await expect(row.firstNameBox()).toBeFocused();
      await refuse.clear();
    });

    await test.step("No connection: Back stays too, with the typing kept", async () => {
      const row = guests.guestRow(fullName);
      const offline = await failRequests(page, GUEST_PATCH(guestId), "PATCH", "network");
      await row.typeFirstNameWithoutLeaving("Offlinename");
      await wedding.goBackWithUnsavedInput();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(new RegExp(`/weddings/${w}$`));
      await expect(row.notSavedYetNote()).toBeVisible();
      await expect(row.firstNameBox()).toHaveValue("Offlinename");
      expect((await weddingData.listGuests(w)).find((g) => g.id === guestId)?.firstName).toBe(name.firstName);
      await offline.clear();
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.saves-on-leaving-a-box-are-never-lost-quietly.failed-save-after-tab-switch-leaves-a-note",
    title: "an email save that fails after the Guests tab was closed leaves a 'Couldn't save' note, never a phantom unsaved prompt",
    objective:
      "Confirms (TS-206) that typing 'jane@' into a guest's email box and clicking the Tables tab straight away opens Tables without asking; that when the held save then comes back 422 the page shows \"Couldn't save <guest>'s email: <reason>\" near the tabs; that clicking Guests and then Tables afterwards never brings up the unsaved-changes question; and that Dismiss removes the note.",
    expectedOutcome:
      "Tables opens with no question. The note reads \"Couldn't save <first> <last>'s email: Enter a valid email address.\" Both later tab clicks open their tab with no question. After Dismiss there is no note.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    const guestId = (await weddingData.createGuest(w, name)).id;

    // The save is held long enough for the tab to close first, then refused.
    const holdThenRefuse = await delayThenFailRequests(page, GUEST_PATCH(guestId), "PATCH", 800, {
      status: 422,
      error: "Enter a valid email address.",
    });

    await test.step("Typing 'jane@' and clicking Tables at once opens Tables without asking", async () => {
      await guests.goto(w);
      await guests.guestRow(fullName).typeEmailWithoutLeaving("jane@");
      await wedding.clickTab("Tables");
      await expect(wedding.tab("Tables")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
    });

    await test.step("The refusal shows as a note near the tabs", async () => {
      await expect(wedding.unsavedNotes()).toContainText(`Couldn't save ${fullName}'s email: Enter a valid email address.`);
    });

    await test.step("Later tab clicks never ask about unsaved changes", async () => {
      await wedding.clickTab("Guests");
      await expect(wedding.tab("Guests")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await wedding.clickTab("Tables");
      await expect(wedding.tab("Tables")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      // The note survives the tab switches until it's dismissed.
      await expect(wedding.unsavedNotes()).toHaveCount(1);
    });

    await test.step("Dismiss removes the note", async () => {
      await wedding.dismissUnsavedNote(/email/);
      await expect(wedding.unsavedNotes()).toHaveCount(0);
    });
    expect(holdThenRefuse.hits).toBe(1);
    await holdThenRefuse.clear();
  },
);

defineQualityTest(
  {
    id: "cross-cutting.saves-on-leaving-a-box-are-never-lost-quietly.header-never-claims-saved-wrongly",
    title: "after Dismiss the header shows nothing, and it never says 'All changes saved' while a refused email is still in its box",
    objective:
      "Confirms (TS-206) that when guest A's email save is refused the header says so; that Dismiss leaves the header empty rather than 'All changes saved'; and that locking guest B afterwards (a save that works) still doesn't say 'All changes saved' while A's refused address is still in its box.",
    expectedOutcome:
      "The header shows the refusal, is empty after Dismiss, and is still empty (never 'All changes saved') after B's lock has saved on the server; A's email box still holds 'jane@'.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const a = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const b = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    const rowA = guests.guestRow(`${a.firstName} ${a.lastName}`);
    const rowB = guests.guestRow(`${b.firstName} ${b.lastName}`);

    await test.step("A's email is refused, and the header says so", async () => {
      await guests.goto(w);
      const refuse = await failRequests(page, GUEST_PATCH(a.id), "PATCH", { status: 422, error: "Enter a valid email address." });
      await rowA.editEmail("jane@");
      await expect(wedding.saveStatus()).toContainText("Enter a valid email address.");
      await refuse.clear();
    });

    await test.step("Dismiss leaves the header empty, not 'All changes saved'", async () => {
      await wedding.dismissSaveError();
      await expect(wedding.saveStatus()).toHaveText("");
    });

    await test.step("Locking B saves, but the header still doesn't claim everything is saved", async () => {
      // toggleLock waits for the lock's save and fails unless the server accepted it.
      await rowB.toggleLock();
      expect(await rowB.isLocked()).toBe(true);
      await expect(wedding.saveStatus()).not.toContainText("All changes saved");
      await expect(wedding.saveStatus()).toHaveText("");
      await expect(rowA.emailBox()).toHaveValue("jane@");
    });
  },
);
