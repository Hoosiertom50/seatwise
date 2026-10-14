/**
 * Review 15 (TS-264 follow-up, REQ-NON-FUNCTIONAL) — leaving the Account page and the dashboard:
 * - Account page (Tom, 10-14): with a password typed in "Delete my account", the browser's Back
 *   asks first (Stay keeps it, Leave goes back) and a reload asks through the browser, as on every
 *   other page.
 * - The leave question opens where it can be seen, even when asked from a wedding lower down the
 *   dashboard list (it opened above the screen on an iPhone, with focus on its hidden Stay).
 * - With the dashboard's past-date question up, Back then Stay puts focus back on "Change it" (it
 *   fell to the top of the page).
 * - A failed "Log out on all devices" puts focus back on the button.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueTitle } from "../data/ids.js";
import { failRequests } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.account-back-and-reload",
    title: "Account page with a password typed: the browser's Back asks first and a reload asks through the browser",
    objective:
      "Confirms (review 15, Tom's decision 10-14) that on the Account page (reached from the dashboard) with a password typed in 'Delete my account', the browser's Back shows 'Leave and clear it?' instead of leaving; Stay keeps the password; Back then Leave without saving goes back to the dashboard; and a reload with a password typed asks through the browser's own question.",
    expectedOutcome:
      "After Back: the question shows and the address is still /account. After Stay: the password box still holds what was typed. After Back and Leave without saving: the address is /dashboard. With a password typed again, a reload is asked about ('beforeunload').",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const accountPage = new AccountPage(page);
    const browserQuestions = new WeddingDetailPage(page);
    await new DashboardPage(page).goto();
    await accountPage.goto();
    await accountPage.typeDeletePassword("typed-not-sent");

    await test.step("Back asks first; Stay keeps the password", async () => {
      await browserQuestions.goBackWithUnsavedInput();
      await expect(accountPage.leaveQuestion()).toBeVisible();
      await expect(page).toHaveURL(/\/account$/);
      await accountPage.stayOnPage();
      await expect(accountPage.deletePasswordInput()).toHaveValue("typed-not-sent");
    });

    await test.step("Back, then Leave without saving, goes back to the dashboard", async () => {
      await browserQuestions.goBackWithUnsavedInput();
      await expect(accountPage.leaveQuestion()).toBeVisible();
      await Promise.all([page.waitForURL(/\/dashboard$/), accountPage.leaveWithoutSaving()]);
    });

    await test.step("A reload with a password typed is asked about", async () => {
      await accountPage.goto();
      await accountPage.typeDeletePassword("typed-again");
      expect(await browserQuestions.reloadAndCatchLeaveQuestion()).toBe("beforeunload");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.question-in-view-and-focus",
    title: "the dashboard's leave question opens on screen when asked from a wedding further down, and Back with the past-date question up then Stay puts focus back on Change it",
    objective:
      "Confirms (review 15) that at phone width, with a wedding name typed and several weddings in the list, clicking the last wedding in the list opens 'Leave and lose what you typed?' inside the window; and that with the past-date question up (focus on Change it), the browser's Back then Stay puts focus back on Change it.",
    expectedOutcome:
      "After clicking the last wedding: the question is visible inside the window and the address is still /dashboard. After Back then Stay with the past-date question up: 'Change it' has focus.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ weddingData, browser, context }, testInfo) => {
    const names: string[] = [];
    for (let i = 0; i < 6; i++) {
      const name = uniqueTitle(testInfo.workerIndex, `List Wedding ${i}`);
      await weddingData.createWedding(name);
      names.push(name);
    }
    const phone = await browser.newContext({ viewport: { width: 375, height: 667 }, storageState: await context.storageState() });
    try {
      const page = await phone.newPage();
      const dashboard = new DashboardPage(page);
      const browserQuestions = new WeddingDetailPage(page);
      await dashboard.goto();

      await test.step("Asked from the first wedding in the list (the oldest, furthest down), the question is on screen", async () => {
        await dashboard.weddingNameInput().fill("Half typed");
        await dashboard.weddingLink(names[0]).click();
        await expect(dashboard.leaveQuestion()).toBeInViewport();
        await expect(page).toHaveURL(/\/dashboard$/);
        await dashboard.stayOnDashboard();
      });

      await test.step("Back with the past-date question up, then Stay, puts focus back on Change it", async () => {
        await dashboard.submitNewWedding("Half typed", "2020-05-16");
        await expect(dashboard.pastDateChangeItButton()).toBeFocused();
        await browserQuestions.goBackWithUnsavedInput();
        await expect(dashboard.leaveQuestion()).toBeVisible();
        await dashboard.stayOnDashboard();
        await expect(dashboard.pastDateChangeItButton()).toBeFocused();
      });
    } finally {
      await phone.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.log-out-everywhere-fails",
    title: "a failed Log out on all devices says why and puts focus back on the button",
    objective:
      "Confirms (review 15) that when 'Log out on all devices' fails (the request answered with a server error), the page says so and keyboard focus is back on the button, rather than at the top of the page.",
    expectedOutcome: "The page stays on /account, the failure message shows, and 'Log out on all devices' has focus.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const accountPage = new AccountPage(page);
    await accountPage.goto();
    const fault = await failRequests(page, /\/api\/v1\/auth\/logout$/, "POST", { status: 500, error: "Something went wrong." });
    try {
      await accountPage.logOutEverywhereButton().click();
      await expect(accountPage.logOutEverywhereMessage()).toBeVisible();
      await expect(accountPage.logOutEverywhereButton()).toBeFocused();
      await expect(page).toHaveURL(/\/account$/);
    } finally {
      await fault.clear();
    }
  },
);
