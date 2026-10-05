/**
 * TS-170 (REQ-NON-FUNCTIONAL) — follow-ups to TS-159 and TS-166 from the second deep dive.
 * - The browser's Back button with half-typed input asks first (it used to leave without a word,
 *   since Back inside the app never unloads the page). Stay keeps the input; Leave goes back.
 * - Clicking "Move to review" while a move is still on its way works -- it used to be refused as
 *   if someone else had changed the plan.
 * - A guest who clears the party-size box and then declines can still send their RSVP (it used to
 *   send a party of 0 and show "Validation failed").
 * - "Export guest list (CSV)" downloads without leaving the page.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { delayRequests } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "cross-cutting.back-button-and-quick-plan-changes-never-lose-work.back-status-decline-export",
    title: "Back with unsaved input asks first, a status change right after a move works, declining with an empty party size works, and the CSV export stays on the page",
    objective:
      "Confirms that pressing the browser's Back button on a wedding with a half-typed guest shows the unsaved-changes prompt, Stay keeps the page and the text, and Leave without saving goes back to the dashboard; that clicking Move to review while a (delayed) move is still saving moves the plan to review with no error; that an RSVP sent as Declined after clearing the party-size box succeeds; and that Export guest list (CSV) starts a download and leaves the page where it is.",
    expectedOutcome:
      "The prompt appears on Back; after Stay the URL is the wedding's and the first-name box reads 'Half-typed'; after Leave the URL is /dashboard. The plan shows 'Move back to draft' and no error, and the guest is at the new table. The RSVP page shows its success banner. A download named for the guest list starts, no unsaved-changes prompt appears, the URL is unchanged and the half-typed first name is still there.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:seating-plan", "@feature:rsvp", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;

    await test.step("Browser Back with a half-typed guest asks first; Stay keeps it, Leave goes back", async () => {
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      await dashboard.weddingLink(managedWedding.name).click();
      await page.waitForURL(new RegExp(`/weddings/${w}$`));
      const guests = new WeddingGuestsPage(page);
      await guests.typeNewGuestFirstName("Half-typed");
      const wedding = new WeddingDetailPage(page);
      await wedding.goBackWithUnsavedInput();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
      await expect(page).toHaveURL(new RegExp(`/weddings/${w}$`));
      expect(await guests.newGuestFirstName()).toBe("Half-typed");
      await wedding.goBackWithUnsavedInput();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.leaveTabWithoutSaving();
      await page.waitForURL(/\/dashboard$/);
    });

    await test.step("Move to review while a move is still saving works", async () => {
      const t1 = await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
      const t2 = await weddingData.createTable(w, { label: "Table 2", capacity: 8 });
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const plan = await weddingData.generatePlanVersion(w);
      const target = plan.assignments.find((a) => a.guestId === guest.id)!.tableId === t1.id ? t2 : t1;
      const planTab = new PlanTabPage(page);
      await planTab.goto(w);
      await planTab.showFloorPlanView();
      const slow = await delayRequests(page, "**/assignments", "POST", 700);
      await planTab.startTapMove(guest.id, target.id);
      await planTab.clickMoveToReview();
      await expect(planTab.moveBackToDraftLocator()).toBeVisible({ timeout: 10_000 });
      await slow.clear();
      const detail = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(detail.status).toBe("IN_REVIEW");
      expect(detail.assignments.find((a) => a.guestId === guest.id)!.tableId).toBe(target.id);
      await expect(planTab.message(/changed since you loaded it/)).toHaveCount(0);
    });

    await test.step("Declining after clearing the party size still sends", async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const rsvp = new GuestRsvpPage(page);
      await rsvp.goto(token);
      await rsvp.clearPartySize();
      await rsvp.submit({ attending: "DECLINED" });
      await expect(rsvp.successBanner()).toBeVisible();
    });

    await test.step("Export guest list (CSV) downloads and stays on the page", async () => {
      const guests = new WeddingGuestsPage(page);
      await guests.goto(w);
      // TS-176: with something half-typed -- leaving the page would ask first and lose it, so this
      // fails if the export ever navigates away (the download alone passed either way).
      await guests.typeNewGuestFirstName("Still here");
      const [download] = await Promise.all([page.waitForEvent("download"), guests.exportCsvLink().click()]);
      expect(download.suggestedFilename()).toMatch(/\.csv$/);
      await expect(new WeddingDetailPage(page).unsavedChangesPrompt()).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/weddings/${w}$`));
      expect(await guests.newGuestFirstName()).toBe("Still here");
    });
  },
);
