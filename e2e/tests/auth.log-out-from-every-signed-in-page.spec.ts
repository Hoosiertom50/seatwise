/**
 * TS-264 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-NON-FUNCTIONAL, Tom's decision 10-13) — every
 * signed-in page has the same controls at the top right: 🔔 bell · Account · Log out (the
 * dashboard, every wedding tab and the Account page). Log out used to be on the dashboard only, so
 * leaving a borrowed tablet on Day-of mode took two clicks.
 * - Log out from a wedding tab and from the Account page lands on the sign-in page, and that
 *   device's session is over (this device only, as on the dashboard -- TS-204).
 * - With unsaved input, Log out asks first (the same question as "Back to dashboard"): Stay keeps
 *   the input and the session; Leave without saving logs out.
 * - At phone width (375px) the controls are visible in the top-right corner, at least 44px tall,
 *   and nothing runs off the screen.
 */

import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { SignedInHeader } from "../components/SignedInHeader.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { WeddingDataSetup } from "../data/api.js";
import { uniqueTestAddress, uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { confirmTestAccountEmail } from "../support/testDatabase.js";

/**
 * A fresh account signed in on two "devices" (browser contexts). Logging out ends the session the
 * test fixtures would clean up with, so these tests use their own account and sign in again to
 * clean up (`cleanUp`).
 */
async function accountOnTwoDevices(browser: Browser, workerIndex: number, label: string) {
  const token = uniqueToken(workerIndex);
  const email = `pw-tester-${label}-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
  const password = randomBytes(16).toString("base64url");
  const signIn = async () => {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    expect((await ctx.request.post("/api/v1/auth/login", { data: { email, password } })).status()).toBe(200);
    return ctx;
  };
  const setup = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
  expect((await setup.request.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).status()).toBe(201);
  await setup.close();
  await confirmTestAccountEmail(email);
  const devices = [await signIn(), await signIn()];
  const signedIn = async (ctx: BrowserContext) => (await ctx.request.get("/api/v1/auth/me")).status();
  const cleanUp = async () => {
    const again = await signIn();
    try {
      await new WeddingDataSetup(again.request).cleanupOwnedWeddings();
    } finally {
      await again.close();
      await Promise.all(devices.map((d) => d.close()));
    }
  };
  return { devices, signedIn, cleanUp };
}

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.wedding-tab-and-account-page",
    title: "Log out from a wedding tab and from the Account page lands on sign-in and ends that device's session only",
    objective:
      "Confirms (TS-264) that the wedding page's Day-of mode tab and the Account page both show the bell, Account and Log out at the top, that Account opens Your account, and that Log out from the Day-of mode tab lands on the sign-in page with that browser's session over while a second browser stays signed in; then that Log out on the second browser's Account page does the same for it.",
    expectedOutcome:
      "On Day-of mode: bell, Account and Log out are visible; after Log out browser 1 is on /login, its /auth/me answers 401 and browser 2's answers 200. Account from the wedding page opens /account with the same controls; after its Log out browser 2 is on /login and its /auth/me answers 401.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "header-logout");
    const [one, two] = devices;
    try {
      const wedding = await new WeddingDataSetup(one.request).createWedding(uniqueTitle(testInfo.workerIndex, "Log Out Wedding"));

      await test.step("Log out on a wedding tab (Day-of mode) signs out this browser only", async () => {
        const page = await one.newPage();
        const dayOf = new DayOfTabPage(page);
        await dayOf.goto(wedding.id);
        const header = new SignedInHeader(page);
        await expect(header.bell()).toBeVisible();
        await expect(header.accountLink()).toBeVisible();
        await header.logOut();
        expect(await signedIn(one)).toBe(401);
        expect(await signedIn(two)).toBe(200);
      });

      await test.step("Account on the wedding page opens Your account, and its Log out signs out that browser", async () => {
        const page = await two.newPage();
        await new WeddingDetailPage(page).goto(wedding.id);
        const header = new SignedInHeader(page);
        await Promise.all([page.waitForURL(/\/account$/), header.accountLink().click()]);
        const account = new AccountPage(page);
        await expect(account.logOutEverywhereButton()).toBeVisible();
        await expect(header.bell()).toBeVisible();
        await header.logOut();
        expect(await signedIn(two)).toBe(401);
      });
    } finally {
      await cleanUp();
    }
  },
);

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.unsaved-input-asks-first",
    title: "Log out with a half-typed guest asks first: Stay keeps the input and the session, Leave without saving logs out",
    objective:
      "Confirms (TS-264, following TS-159/TS-166) that Log out on the wedding page goes through the same unsaved-changes guard as Back to dashboard: with a half-typed guest name it asks 'You have unsaved changes on this tab' instead of logging out; Stay keeps the typing, the page and the session, with focus back on Log out; and Log out then Leave without saving lands on the sign-in page with the session over.",
    expectedOutcome:
      "After the first Log out: the question shows, the address is still the wedding and /auth/me answers 200. After Stay: no question, the first-name box still reads 'Half-typed', Log out has focus. After Log out and Leave without saving: the browser is on /login and /auth/me answers 401.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "header-unsaved");
    const [one] = devices;
    try {
      const wedding = await new WeddingDataSetup(one.request).createWedding(uniqueTitle(testInfo.workerIndex, "Unsaved Log Out Wedding"));
      const page = await one.newPage();
      const guests = new WeddingGuestsPage(page);
      const detail = new WeddingDetailPage(page);
      const header = new SignedInHeader(page);
      await guests.goto(wedding.id);
      await guests.typeNewGuestFirstName("Half-typed");

      await test.step("Log out asks first, and nothing is logged out yet", async () => {
        await header.pressLogOut();
        await expect(detail.unsavedChangesPrompt()).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/weddings/${wedding.id}$`));
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Stay keeps the typing and the session, with focus back on Log out", async () => {
        await detail.stayOnTab();
        await expect(detail.unsavedChangesPrompt()).toHaveCount(0);
        expect(await guests.newGuestFirstName()).toBe("Half-typed");
        await expect(header.logOutButton()).toBeFocused();
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Log out, then Leave without saving, logs out", async () => {
        await header.pressLogOut();
        await expect(detail.unsavedChangesPrompt()).toBeVisible();
        await Promise.all([page.waitForURL(/\/login/), detail.leaveTabWithoutSaving()]);
        expect(await signedIn(one)).toBe(401);
      });
    } finally {
      await cleanUp();
    }
  },
);

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.visible-at-phone-width",
    title: "at phone width the bell, Account and Log out sit in the top-right corner of every signed-in page, 44px tall, with nothing off the screen",
    objective:
      "Confirms (TS-264) that at 375px wide, on the dashboard, a wedding tab (Guests) and the Account page, the header's bell, Account and Log out are visible, inside the window, near the top and toward the right, each at least 44px tall, and the page is no wider than the window.",
    expectedOutcome:
      "On each of the three pages: every control is visible, its right edge is within 375px, its top is within the first 150px, the Log out button's right edge is in the right half, each is at least 44px tall, and the page overflows by 0px.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, browser, context }) => {
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, storageState: await context.storageState() });
    try {
      const page = await phone.newPage();
      const header = new SignedInHeader(page);
      const pages: Array<[string, () => Promise<void>]> = [
        ["dashboard", () => new DashboardPage(page).goto()],
        ["wedding (Guests tab)", () => new WeddingGuestsPage(page).goto(managedWedding.id)],
        ["Account page", () => new AccountPage(page).goto()],
      ];
      for (const [label, open] of pages) {
        await test.step(`${label}: the controls are in the top-right corner, 44px tall, nothing off the screen`, async () => {
          await open();
          for (const control of [header.bell(), header.accountLink(), header.logOutButton()]) {
            await expect(control).toBeVisible();
            const box = (await control.boundingBox())!;
            expect(box.x + box.width).toBeLessThanOrEqual(375);
            expect(box.y).toBeLessThan(150);
            expect(box.height).toBeGreaterThanOrEqual(44);
          }
          const logOut = (await header.logOutButton().boundingBox())!;
          expect(logOut.x + logOut.width).toBeGreaterThan(375 / 2);
          expect(await header.horizontalOverflow()).toBe(0);
        });
      }
    } finally {
      await phone.close();
    }
  },
);
