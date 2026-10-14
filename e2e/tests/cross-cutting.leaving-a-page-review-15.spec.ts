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
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueTestAddress, uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { watchBrowserQuestions } from "../support/browserQuestions.js";
import { delayResponses, failRequests } from "../support/networkFaults.js";
import { patchWedding } from "../data/api.js";
import { emptyThenClickAtOnce } from "../support/emptyThenClick.js";
import { waitForPageToSettle } from "../support/pageSettled.js";

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

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.refusal-just-before-the-tab-closes",
    title: "a wedding name refused just before its tab closes still leaves a Couldn't save note",
    objective:
      "Confirms (review 15) that when the Wedding name box is typed in, the name is changed elsewhere meanwhile, and the planner presses the Guests tab -- the refusal (409) arriving while the Collaborators tab is still open (as when the mouse is held down on Guests), and the tab closing just after -- the page shows 'Couldn't save the wedding name: …' (it only did when the tab had closed before the answer came).",
    expectedOutcome: "After the mouse comes up on Guests: the Guests tab is open and a note containing \"Couldn't save the wedding name\" shows.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const detail = new WeddingDetailPage(page);
    const collaborators = new CollaboratorsTabPage(page);
    await collaborators.goto(managedWedding.id);
    await collaborators.weddingNameInput().fill(`${managedWedding.name} Mine`);
    expect((await patchWedding(context.request, managedWedding.id, { data: { name: `${managedWedding.name} Elsewhere` } })).ok()).toBe(true);
    // Leave the box (it saves), wait for the refusal while this tab is still open, then open Guests --
    // the moment a person pressing and holding the Guests tab gets to.
    const refused = page.waitForResponse((r) => r.request().method() === "PATCH" && r.status() === 409);
    await collaborators.weddingNameInput().press("Tab");
    await refused;
    await detail.clickTab("Guests");
    await expect(detail.tab("Guests")).toHaveAttribute("aria-selected", "true");
    await expect(detail.unsavedNotes().filter({ hasText: "Couldn't save the wedding name" })).toBeVisible();
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.after-deleting-the-account",
    title: "after deleting the account, a reload asks nothing and Back leaves the page",
    objective:
      "Confirms (PR #115 review) that once an account is deleted from the Account page, the typed password no longer counts as unsaved: reloading the 'deleted' page brings up no browser question, and the browser's Back leaves /account (it used to ask a question that page never shows, so Back did nothing).",
    expectedOutcome: "After the delete: the 'deleted' heading shows; a reload asks no browser question; Back lands on a page other than /account.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    try {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-deleted-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      const password = `pw-${token}-long-enough`;
      expect((await context.request.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).ok()).toBe(true);
      const page = await context.newPage();
      const accountPage = new AccountPage(page);
      await new DashboardPage(page).goto();
      await accountPage.goto();
      await accountPage.deleteAccount(password);
      await expect(accountPage.deletedHeading()).toBeVisible();

      const questions = watchBrowserQuestions(page);
      try {
        await page.reload();
      } finally {
        questions.stop();
      }
      expect(questions.asked).toEqual([]);
      // The reloaded page takes its leftover extra history entry off with a Back of its own; a Back
      // pressed in those few milliseconds was cancelled by it on Firefox (NS_BINDING_ABORTED).
      await waitForPageToSettle(page);
      await page.goBack();
      await expect(page).not.toHaveURL(/\/account$/);
    } finally {
      await context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.retry-saved-before-the-tab-closes",
    title: "a wedding name refused, then saved on a retry, leaves no Couldn't save note when its tab closes",
    objective:
      "Confirms (PR #115 review) that when a Wedding name save is refused (409, the name was changed elsewhere), the planner types a new name and it saves, and they open the Guests tab within a couple of seconds of the refusal, no 'Couldn't save the wedding name' note shows -- the retry saved, so the earlier refusal no longer applies.",
    expectedOutcome: "After the retry saves, the Guests tab opens, and the Collaborators tab is opened again (showing the retried name): no note containing \"Couldn't save the wedding name\" shows.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const detail = new WeddingDetailPage(page);
    const collaborators = new CollaboratorsTabPage(page);
    await collaborators.goto(managedWedding.id);
    await collaborators.weddingNameInput().fill(`${managedWedding.name} Mine`);
    expect((await patchWedding(context.request, managedWedding.id, { data: { name: `${managedWedding.name} Elsewhere` } })).ok()).toBe(true);
    const refused = page.waitForResponse((r) => r.request().method() === "PATCH" && r.status() === 409);
    await collaborators.weddingNameInput().press("Tab");
    await refused;
    await collaborators.weddingNameInput().fill(`${managedWedding.name} Retry`);
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.ok());
    await collaborators.weddingNameInput().press("Tab");
    await saved;
    await detail.clickTab("Guests");
    await expect(detail.tab("Guests")).toHaveAttribute("aria-selected", "true");
    // The page's notes stay across tabs, and one would show a render after the tab closed -- so look
    // once the page has gone on to another tab and back.
    await detail.clickTab("Collaborators");
    await expect(collaborators.weddingNameInput()).toHaveValue(`${managedWedding.name} Retry`);
    await expect(detail.unsavedNotes().filter({ hasText: "Couldn't save the wedding name" })).toHaveCount(0);
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.dashboard-link-right-after-emptying",
    title: "the dashboard's Account link opens the Account page even when followed the moment the Add a wedding form is emptied",
    objective:
      "Confirms (PR #115 review) that emptying the dashboard's 'Add a wedding' name box and following the Account link in the same moment still opens the Account page -- emptying the form starts the page's own Back (taking its extra history entry off), and that Back used to cancel the Account page, leaving the dashboard on screen.",
    expectedOutcome: "The address ends on /account.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:portfolio", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }, testInfo) => {
    void account;
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    await dashboard.weddingNameInput().fill(uniqueTitle(testInfo.workerIndex, "Emptied"));
    await emptyThenClickAtOnce(dashboard.weddingNameInput(), dashboard.accountLink());
    await expect(page).toHaveURL(/\/account$/);
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.account-link-right-after-emptying",
    title: "the Account page's Back to your weddings link opens the dashboard even when followed the moment the password box is emptied",
    objective:
      "Confirms (PR #115 review) that on the Account page, emptying the 'Delete my account' password box and following '← Back to your weddings' in the same moment still opens the dashboard (the page's own Back, taking its extra history entry off, used to cancel it).",
    expectedOutcome: "The address ends on /dashboard.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const accountPage = new AccountPage(page);
    await new DashboardPage(page).goto();
    await accountPage.goto();
    await accountPage.typeDeletePassword("not-my-password");
    await emptyThenClickAtOnce(accountPage.deletePasswordInput(), accountPage.backToWeddingsLink());
    await expect(page).toHaveURL(/\/dashboard$/);
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-15.typed-while-logging-out",
    title: "typing in the Add a wedding form while Log out is on its way still opens the sign-in page, with no browser question",
    objective:
      "Confirms (PR #115 review) that on the dashboard with nothing typed, pressing Log out and then typing in the 'Add a wedding' name box before the log out has finished still opens the sign-in page once it has -- the session is over, so the browser's 'Leave site?' question isn't asked (cancelling it used to leave the signed-out dashboard on screen).",
    expectedOutcome: "After the slowed log out finishes: the address ends on /login and no browser question was asked.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    try {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-logout-typing-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      expect((await context.request.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password: `pw-${token}-long-enough` } })).ok()).toBe(true);
      const page = await context.newPage();
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      const slowLogOut = await delayResponses(page, /\/api\/v1\/auth\/logout$/, "POST", 1_500);
      const questions = watchBrowserQuestions(page);
      try {
        await dashboard.logout();
        await dashboard.weddingNameInput().fill(uniqueTitle(testInfo.workerIndex, "Typed While Leaving"));
        await expect(page).toHaveURL(/\/login$/);
      } finally {
        questions.stop();
        await slowLogOut.clear();
      }
      expect(questions.asked).toEqual([]);
    } finally {
      await context.close();
    }
  },
);

