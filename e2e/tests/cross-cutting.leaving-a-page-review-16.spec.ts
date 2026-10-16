/**
 * Review 16 (REQ-NON-FUNCTIONAL) — Log out while a save is still on its way (a slow Generate, a
 * guest being removed) asked the browser's "Leave site?" (the save-status indicator's own question),
 * and Cancel left the signed-out wedding page on screen. Once the log out has finished, the page goes
 * to the sign-in page without asking.
 * - The Account page's "Sign in" link (shown when Log out on all devices finds this browser already
 *   signed out) asks first with a password typed, like every other way off that page.
 */

import { expect, defineQualityTest } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingDataSetup } from "../data/api.js";
import { uniqueTestAddress, uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { watchBrowserQuestions } from "../support/browserQuestions.js";
import { delayRequests } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-16.log-out-while-generating",
    title: "Log out while a plan is still being generated opens the sign-in page, with no browser question",
    objective:
      "Confirms (review 16) that on the Seating plan tab, pressing Log out while Generate is still on its way (shown as Saving…) ends on the sign-in page and the browser's 'Leave site?' question isn't asked -- Cancel on it used to leave the signed-out wedding page on screen.",
    expectedOutcome: "The address ends on /login and no browser question was asked.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    try {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-generate-logout-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      expect((await context.request.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password: `pw-${token}-long-enough` } })).ok()).toBe(true);
      const data = new WeddingDataSetup(context.request);
      const wedding = await data.createWedding(uniqueTitle(testInfo.workerIndex, "Generate Log Out"));
      await data.createTable(wedding.id, { label: "Table 1", capacity: 8 });
      await data.createGuest(wedding.id, { firstName: "Ann", lastName: "Lee" });

      const page = await context.newPage();
      const plan = new PlanTabPage(page);
      await plan.goto(wedding.id);
      const slowGenerate = await delayRequests(page, /\/plan-versions\/generate$/, "POST", 4_000);
      const questions = watchBrowserQuestions(page);
      try {
        await plan.clickGenerate();
        const detail = new WeddingDetailPage(page);
        await expect(detail.saveStatus()).toHaveText("Saving…");
        await detail.logOut();
        await expect(page).toHaveURL(/\/login$/);
      } finally {
        questions.stop();
        await slowGenerate.clear();
      }
      expect(questions.asked).toEqual([]);
    } finally {
      await context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-16.account-sign-in-link-asks",
    title: "the Account page's Sign in link asks first when a password is typed",
    objective:
      "Confirms (review 16) that on the Account page, after Log out on all devices finds this browser already signed out and shows its 'Sign in' link, following that link with a password typed in 'Delete my account' shows the page's 'Leave and clear it?' question instead of leaving at once (it left without asking and left an extra history entry behind).",
    expectedOutcome: "After clicking Sign in: the leave question shows and the address is still /account.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    try {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-sign-in-link-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      expect((await context.request.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password: `pw-${token}-long-enough` } })).ok()).toBe(true);
      const page = await context.newPage();
      const account = new AccountPage(page);
      await new DashboardPage(page).goto();
      await account.goto();
      // This browser's session ends elsewhere, so Log out on all devices offers "Sign in".
      expect((await context.request.post("/api/v1/auth/logout")).status()).toBe(200);
      expect(await account.pressLogOutEverywhere()).toBe(401);
      await expect(account.logOutEverywhereSignInLink()).toBeVisible();

      await account.typeDeletePassword("not-my-password");
      await account.logOutEverywhereSignInLink().click();
      await expect(account.leaveQuestion()).toBeVisible();
      await expect(page).toHaveURL(/\/account$/);
    } finally {
      await context.close();
    }
  },
);

