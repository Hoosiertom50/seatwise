/**
 * TS-175 (REQ-NON-FUNCTIONAL) — the browser's Back button with unsaved input asks first every
 * time, not just the first time (TS-170's guard stopped working after a save), and the extra
 * history entry it uses never gets in the way:
 * - after a save, typing again and pressing Back still asks; with nothing unsaved, one Back leaves;
 * - after a reload, one Back leaves (it used to do nothing);
 * - opened in a fresh tab, "Leave without saving" goes to the dashboard (it used to stay put);
 * - leaving through the page's own link leaves no dead copy of the page behind in history.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";

defineQualityTest(
  {
    id: "cross-cutting.back-button-guard-works-every-time.after-save-reload-fresh-tab-link",
    title: "Back with unsaved input asks every time, and after a save, a reload, a fresh tab or a link the page's history still behaves",
    objective:
      "Confirms that after adding a guest, typing again and pressing Back shows the unsaved-changes prompt, and once saved one Back reaches the dashboard; that after a reload with half-typed input one Back reaches the dashboard; that in a tab opened straight on the wedding, Back asks and Leave without saving goes to the dashboard; and that after leaving through Back to dashboard, Back returns to the wedding and Back again to the dashboard.",
    expectedOutcome:
      "The prompt appears each time there's unsaved input; every Leave or plain Back lands on /dashboard; Back from the dashboard after leaving by the link lands on the wedding, then on /dashboard.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, context, page }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const weddingUrl = new RegExp(`/weddings/${w}$`);
    // A reload with unsaved input raises the browser's own "leave site?" question.
    page.on("dialog", (dialog) => void dialog.accept());
    const dashboard = new DashboardPage(page);
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    const openFromDashboard = async () => {
      await dashboard.goto();
      await dashboard.weddingLink(managedWedding.name).click();
      await page.waitForURL(weddingUrl);
    };

    await test.step("After a save, Back still asks; with nothing unsaved one Back leaves", async () => {
      await openFromDashboard();
      await guests.typeNewGuestFirstName("First");
      await guests.finishAddingGuest(uniquePersonName(testInfo.workerIndex).lastName);
      await expect.poll(() => guests.newGuestFirstName()).toBe("");
      await guests.typeNewGuestFirstName("Second");
      await page.goBack();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
      await guests.finishAddingGuest(uniquePersonName(testInfo.workerIndex).lastName);
      await expect.poll(() => guests.newGuestFirstName()).toBe("");
      await page.goBack();
      await page.waitForURL(/\/dashboard$/);
    });

    await test.step("After a reload, one Back leaves", async () => {
      await openFromDashboard();
      await guests.typeNewGuestFirstName("Half-typed");
      await page.reload();
      await expect(wedding.backToDashboardLink()).toBeVisible();
      await page.goBack();
      await page.waitForURL(/\/dashboard$/);
    });

    await test.step("In a fresh tab, Leave without saving goes to the dashboard", async () => {
      // Opened the way a link opens in a new tab: the wedding is the tab's first page.
      const [fresh] = await Promise.all([
        context.waitForEvent("page"),
        page.evaluate((url) => void window.open(url, "_blank"), `/weddings/${w}`),
      ]);
      try {
        await fresh.waitForURL(weddingUrl);
        const freshGuests = new WeddingGuestsPage(fresh);
        const freshWedding = new WeddingDetailPage(fresh);
        await freshGuests.typeNewGuestFirstName("Half-typed");
        await fresh.goBack();
        await expect(freshWedding.unsavedChangesPrompt()).toBeVisible();
        await freshWedding.leaveTabWithoutSaving();
        await fresh.waitForURL(/\/dashboard$/);
      } finally {
        await fresh.close();
      }
    });

    await test.step("Leaving through the page's link leaves no dead copy in history", async () => {
      await openFromDashboard();
      await guests.typeNewGuestFirstName("Half-typed");
      await wedding.backToDashboardLink().click();
      await wedding.leaveTabWithoutSaving();
      await page.waitForURL(/\/dashboard$/);
      await page.goBack();
      await page.waitForURL(weddingUrl);
      await page.goBack();
      await page.waitForURL(/\/dashboard$/);
    });
  },
);
