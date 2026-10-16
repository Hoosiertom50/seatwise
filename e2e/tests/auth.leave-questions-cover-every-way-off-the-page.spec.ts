/**
 * Review 14 (TS-264 follow-up) — on the dashboard and the Account page, every way off the page asks
 * about what's typed, not only the header's controls, and a question about a page you're already
 * on isn't asked at all:
 * - Dashboard, with a half-typed new wedding: the bell's "Back to dashboard" just closes the list
 *   (it used to ask, and Leave did nothing); a wedding in the list and "Duplicate layout" ask first.
 * - Account, with a password typed in "Delete my account": "Log out on all devices" asks first.
 * - A Log out that fails after "Leave without saving" keeps what was typed and puts focus back on
 *   Log out (on the Account page the password used to be cleared, and focus fell to the page).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { NotificationsBell } from "../components/NotificationsBell.js";
import { SignedInHeader } from "../components/SignedInHeader.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";

const LOG_OUT_ADDRESS = "**/api/v1/auth/logout";

defineQualityTest(
  {
    id: "auth.leave-questions-cover-every-way-off-the-page.dashboard",
    title: "dashboard with a half-typed wedding: the bell's Back to dashboard asks nothing, a wedding link and Duplicate layout ask first",
    objective:
      "Confirms (review 14) that with a wedding name typed in 'Add a wedding', the bell's 'Back to dashboard' closes the list without a question and keeps the typing; that clicking a wedding in the list asks 'Leave and lose what you typed?' and Stay keeps the typing on the dashboard with focus back on that link; and that 'Duplicate layout' asks the same and Stay creates nothing.",
    expectedOutcome:
      "After Back to dashboard: no question, the list is closed, the name box still reads 'Half typed'. After the wedding link: the question shows, the address is still /dashboard; Stay keeps 'Half typed' and focuses the link. After Duplicate layout: the question shows; Stay leaves the number of weddings unchanged.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const dashboard = new DashboardPage(page);
    const bell = new NotificationsBell(page);
    const weddingCount = async () =>
      ((await (await context.request.get("/api/v1/weddings")).json()) as { weddings: unknown[] }).weddings.length;
    await dashboard.goto();
    await dashboard.weddingNameInput().fill("Half typed");

    await test.step("The bell's Back to dashboard closes the list and asks nothing", async () => {
      await bell.toggle();
      await bell.backToDashboardLink().click();
      await expect(bell.panel()).toHaveCount(0);
      await expect(dashboard.leaveQuestion()).toHaveCount(0);
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(dashboard.weddingNameInput()).toHaveValue("Half typed");
    });

    await test.step("A wedding in the list asks first; Stay keeps the typing", async () => {
      const link = dashboard.weddingLink(managedWedding.name);
      await link.click();
      await expect(dashboard.leaveQuestion()).toBeVisible();
      await expect(page).toHaveURL(/\/dashboard$/);
      await dashboard.stayOnDashboard();
      await expect(dashboard.leaveQuestion()).toHaveCount(0);
      await expect(dashboard.weddingNameInput()).toHaveValue("Half typed");
      await expect(link).toBeFocused();
    });

    await test.step("Duplicate layout asks first; Stay creates nothing", async () => {
      const before = await weddingCount();
      await dashboard.duplicateLayoutButton(managedWedding.name).click();
      await expect(dashboard.leaveQuestion()).toBeVisible();
      await dashboard.stayOnDashboard();
      await expect(dashboard.weddingNameInput()).toHaveValue("Half typed");
      expect(await weddingCount()).toBe(before);
    });
  },
);

defineQualityTest(
  {
    id: "auth.leave-questions-cover-every-way-off-the-page.account",
    title: "Account page with a password typed: Log out on all devices asks first, and a failed Log out keeps the password",
    objective:
      "Confirms (review 14) that with a password typed in 'Delete my account', 'Log out on all devices' asks 'Leave and clear it?' and Stay keeps the password and the session; and that when Log out fails after 'Leave without saving' (the log-out request is blocked), the page says why, still holds the typed password and puts focus back on Log out.",
    expectedOutcome:
      "After Log out on all devices: the question shows and no log-out request is sent; Stay keeps the password. After Log out → Leave without saving with the request blocked: 'Couldn't log out — check your connection and try again.' shows, the password box still holds what was typed, Log out has focus and the address is still /account.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const accountPage = new AccountPage(page);
    const header = new SignedInHeader(page);
    await accountPage.goto();
    await accountPage.typeDeletePassword("typed-not-sent");

    await test.step("Log out on all devices asks first; Stay keeps the password", async () => {
      let logOuts = 0;
      await page.route(LOG_OUT_ADDRESS, (route) => {
        logOuts++;
        return route.continue();
      });
      try {
        await accountPage.logOutEverywhereButton().click();
        await expect(accountPage.leaveQuestion()).toBeVisible();
        await accountPage.stayOnPage();
        await expect(accountPage.deletePasswordInput()).toHaveValue("typed-not-sent");
        expect(logOuts).toBe(0);
      } finally {
        await page.unroute(LOG_OUT_ADDRESS);
      }
    });

    await test.step("A Log out that fails keeps the password, says why and puts focus on Log out", async () => {
      await page.route(LOG_OUT_ADDRESS, (route) => route.abort());
      try {
        await header.pressLogOut();
        await expect(accountPage.leaveQuestion()).toBeVisible();
        await accountPage.leaveWithoutSaving();
        await expect(header.logOutFailedMessage()).toBeVisible();
        await expect(accountPage.deletePasswordInput()).toHaveValue("typed-not-sent");
        await expect(header.logOutButton()).toBeFocused();
        await expect(page).toHaveURL(/\/account$/);
      } finally {
        await page.unroute(LOG_OUT_ADDRESS);
      }
    });
  },
);

defineQualityTest(
  {
    id: "auth.leave-questions-cover-every-way-off-the-page.dashboard-failed-log-out",
    title: "dashboard: a Log out that fails after Leave without saving keeps the typing and puts focus back on Log out",
    objective:
      "Confirms (review 14) that on the dashboard, with a wedding name typed, Log out → Leave without saving with the log-out request blocked says why, keeps the typed name and puts keyboard focus back on Log out (it fell to the page).",
    expectedOutcome:
      "'Couldn't log out — check your connection and try again.' shows, the name box still reads 'Half typed', Log out has focus and the address is still /dashboard.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const dashboard = new DashboardPage(page);
    const header = new SignedInHeader(page);
    await dashboard.goto();
    await dashboard.weddingNameInput().fill("Half typed");
    await page.route(LOG_OUT_ADDRESS, (route) => route.abort());
    try {
      await header.pressLogOut();
      await expect(dashboard.leaveQuestion()).toBeVisible();
      await dashboard.leaveWithoutSaving();
      await expect(header.logOutFailedMessage()).toBeVisible();
      await expect(dashboard.weddingNameInput()).toHaveValue("Half typed");
      await expect(header.logOutButton()).toBeFocused();
      await expect(page).toHaveURL(/\/dashboard$/);
    } finally {
      await page.unroute(LOG_OUT_ADDRESS);
    }
  },
);
