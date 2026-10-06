/**
 * TS-166 (REQ-NON-FUNCTIONAL) — quick clicks and network hiccups never leave the screen wrong or
 * blame someone else.
 * - Day-of: marking two guests Not Attending in quick succession keeps both marked (the second
 *   reply used to undo the first on screen), and seating two guests quickly seats both (the second
 *   used to be refused as if someone else had changed the plan).
 * - Tables: ticking Accessible and then Single-side quickly saves both, with no "changed since you loaded it".
 * - RSVP page: a failed load says so and offers Try again -- it used to say the link didn't exist.
 * - "Back to dashboard" with half-typed input asks first, like switching tabs (TS-159).
 * - Budget: if only the totals refresh fails after adding a vendor, the vendor is still shown as
 *   added and the form is cleared -- it used to say "Couldn't add" and keep the form filled.
 * Server replies are delayed or failed on purpose (support/networkFaults.ts) so the timing is the
 * same on every run.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { delayRequests, failRequests } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "cross-cutting.quick-clicks-and-hiccups-never-mislead.day-of-tables-rsvp-leave-budget",
    title: "quick clicks on Day-of and Tables all land, a failed RSVP load offers Try again, leaving with unsaved input asks first, and a failed totals refresh doesn't undo an added vendor",
    objective:
      "With each save delayed 700 ms: confirms two quick Not Attending clicks leave both guests Not Attending, two quick seatings seat both guests with no error, and ticking Accessible then Single-side quickly saves both with no error. Confirms a 500 on the RSVP page's first load shows Try again (not 'doesn't exist') and Try again loads the form; that Back to dashboard with a half-typed guest asks first and Stay keeps the input; and that a failed budget refresh after adding a vendor still lists it, clears the form, and says the totals couldn't be refreshed.",
    expectedOutcome:
      "Both guests show 'Mark attending'; both appear seated in the plan; both table checkboxes stay ticked after a reload with no error shown; the RSVP page shows Try again then the guest's form; the unsaved-changes prompt appears and the first-name box still holds the text; the budget shows one vendor, an empty name box and 'Saved — but the budget totals couldn't be refreshed'.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:tables", "@feature:rsvp", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const table = await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    const a = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const b = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const nameOf = (g: { firstName: string; lastName: string }) => `${g.firstName} ${g.lastName}`;
    const plan = await weddingData.generatePlanVersion(w);
    const dayOf = new DayOfTabPage(page);

    await test.step("Day-of: two quick Not Attending clicks both stick", async () => {
      await dayOf.goto(w);
      const slow = await delayRequests(page, "**/attendance", "POST", 700);
      await dayOf.attendanceButtonLocator(nameOf(a)).click();
      await dayOf.attendanceButtonLocator(nameOf(b)).click();
      for (const g of [a, b]) {
        await expect(dayOf.attendanceButtonLocator(nameOf(g))).toHaveText(/^mark attending$/i, { timeout: 10_000 });
      }
      await slow.clear();
      await expect(dayOf.errorText()).toHaveCount(0);
    });

    await test.step("Day-of: seating two guests quickly seats both, with no conflict", async () => {
      await dayOf.toggleAttendance(nameOf(a));
      await dayOf.toggleAttendance(nameOf(b));
      const slow = await delayRequests(page, "**/assignments", "POST", 700);
      await dayOf.seatGuestAt(nameOf(a), "Table 1");
      await dayOf.seatGuestAt(nameOf(b), "Table 1");
      await expect
        .poll(async () => (await weddingData.getPlanVersionDetail(w, plan.id)).assignments.map((x) => x.guestId).sort(), { timeout: 10_000 })
        .toEqual([a.id, b.id].sort());
      await slow.clear();
      await expect(dayOf.errorText()).toHaveCount(0);
    });

    await test.step("Tables: Accessible then Single-side, ticked quickly, both save", async () => {
      const tables = new TablesTabPage(page);
      await tables.goto(w);
      await tables.openTablesTab();
      const slow = await delayRequests(page, `**/tables/${table.id}`, "PATCH", 700);
      await tables.accessibleCheckbox("Table 1").check();
      await tables.singleSideCheckbox("Table 1").check();
      await expect.poll(async () => slow.hits, { timeout: 5_000 }).toBe(2);
      await expect
        .poll(async () => {
          const t = (await weddingData.listTables(w)).find((x) => x.id === table.id)!;
          return [t.isAccessible, t.singleSideOnly];
        }, { timeout: 10_000 })
        .toEqual([true, true]);
      await slow.clear();
      await expect(tables.errorText()).toHaveCount(0);
    });

    await test.step("RSVP page: a failed load offers Try again instead of calling the link dead", async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const rsvp = new GuestRsvpPage(page);
      const fault = await failRequests(page, `**/api/v1/rsvp/${token}`, "GET", { status: 500, error: "Simulated outage." }, 1);
      await rsvp.goto(token);
      await expect(rsvp.tryAgainButton()).toBeVisible();
      await expect(rsvp.notFoundMessage()).toHaveCount(0);
      await rsvp.tryAgainButton().click();
      await expect(rsvp.pageText(guest.firstName).first()).toBeVisible();
      await fault.clear();
    });

    await test.step("Back to dashboard with a half-typed guest asks first; Stay keeps it", async () => {
      const guests = new WeddingGuestsPage(page);
      await guests.goto(w);
      await guests.typeNewGuestFirstName("Half-typed");
      const wedding = new WeddingDetailPage(page);
      await wedding.backToDashboardLink().click();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
      await expect(page).toHaveURL(new RegExp(`/weddings/${w}$`));
      expect(await guests.newGuestFirstName()).toBe("Half-typed");
    });

    await test.step("Budget: a failed totals refresh doesn't undo an added vendor", async () => {
      const budget = new BudgetTabPage(page);
      await budget.goto(w);
      const fault = await failRequests(page, `**/api/v1/weddings/${w}/budget`, "GET", { status: 500, error: "Simulated outage." }, 1);
      await budget.addVendor({ name: "Quick Florist", category: "Florist" });
      await expect(budget.vendorsHeading(1)).toBeVisible();
      await expect(budget.vendorNameInputLocator()).toHaveValue("");
      await expect(budget.errorText()).toContainText("Saved — but the budget totals couldn't be refreshed");
      await fault.clear();
    });
  },
);
