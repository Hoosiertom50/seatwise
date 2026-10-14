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
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { WeddingDataSetup } from "../data/api.js";
import { uniqueTestAddress, uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { confirmTestAccountEmail } from "../support/testDatabase.js";
import { delayPagesOwnBack } from "../support/slowDevice.js";

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

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.dashboard-typed-wedding-asks-first",
    title: "Log out on the dashboard with a half-typed new wedding asks first: Stay keeps the typing, Leave without saving logs out",
    objective:
      "Confirms (TS-264, PR #114 review) that the dashboard's Log out goes through an unsaved-changes question when something has been typed in the 'Add a wedding' form: Stay keeps the typing and the session; Log out then Leave without saving lands on the sign-in page with the session over. With nothing typed, Log out goes straight through (covered by the other tests).",
    expectedOutcome:
      "After the first Log out: the question 'You've started adding a wedding. Leave and lose what you typed?' shows, the address is still the dashboard and /auth/me answers 200. After Stay: no question, the wedding-name box still reads the typed name and Log out has focus. After Log out and Leave without saving: the browser is on /login and /auth/me answers 401.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "dash-unsaved");
    const [one] = devices;
    try {
      const page = await one.newPage();
      const dashboard = new DashboardPage(page);
      const header = new SignedInHeader(page);
      await dashboard.goto();
      await dashboard.weddingNameInput().fill("Half-typed wedding");
      const question = dashboard.leaveQuestion();

      await test.step("Log out asks first, and nothing is logged out yet", async () => {
        await header.pressLogOut();
        await expect(question).toBeVisible();
        await expect(page).toHaveURL(/\/dashboard$/);
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Stay keeps the typing and the session, with focus back on Log out", async () => {
        await dashboard.stayOnDashboard();
        await expect(question).toHaveCount(0);
        await expect(dashboard.weddingNameInput()).toHaveValue("Half-typed wedding");
        await expect(header.logOutButton()).toBeFocused();
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Log out, then Leave without saving, logs out", async () => {
        await header.pressLogOut();
        await Promise.all([page.waitForURL(/\/login/), dashboard.leaveWithoutSaving()]);
        expect(await signedIn(one)).toBe(401);
      });
    } finally {
      await cleanUp();
    }
  },
);

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.account-typed-password-asks-first",
    title: "Log out on the Account page with a password typed in Delete my account asks first: Stay keeps it, Leave without saving logs out",
    objective:
      "Confirms (TS-264, PR #114 review) that the Account page's Log out asks before throwing away a password typed in 'Delete my account': Stay keeps the typed password and the session; Log out then Leave without saving lands on the sign-in page with the session over.",
    expectedOutcome:
      "After the first Log out: the question 'You've typed your password to delete your account. Leave and clear it?' shows, the address is still /account and /auth/me answers 200. After Stay: no question, the password box still holds what was typed and Log out has focus. Account (the page it is on) asks nothing and keeps the password. Escape on the question does the same. After Log out and Leave without saving: the browser is on /login and /auth/me answers 401.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "account-unsaved");
    const [one] = devices;
    try {
      const page = await one.newPage();
      const account = new AccountPage(page);
      const header = new SignedInHeader(page);
      await account.goto();
      await account.typeDeletePassword("not-sent-yet");

      await test.step("Log out asks first, and nothing is logged out yet", async () => {
        await header.pressLogOut();
        await expect(account.leaveQuestion()).toBeVisible();
        await expect(page).toHaveURL(/\/account$/);
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Stay keeps the typed password and the session, with focus back on Log out", async () => {
        await account.stayOnPage();
        await expect(account.leaveQuestion()).toHaveCount(0);
        await expect(account.deletePasswordInput()).toHaveValue("not-sent-yet");
        await expect(header.logOutButton()).toBeFocused();
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Account (this same page) asks nothing and keeps the typed password", async () => {
        await header.accountLink().click();
        await expect(account.leaveQuestion()).toHaveCount(0);
        await expect(page).toHaveURL(/\/account$/);
        await expect(account.deletePasswordInput()).toHaveValue("not-sent-yet");
      });

      await test.step("Escape also means Stay, with focus back on Log out", async () => {
        await header.pressLogOut();
        await expect(account.leaveQuestion()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(account.leaveQuestion()).toHaveCount(0);
        await expect(header.logOutButton()).toBeFocused();
      });

      await test.step("Log out, then Leave without saving, logs out", async () => {
        await header.pressLogOut();
        await Promise.all([page.waitForURL(/\/login/), account.leaveWithoutSaving()]);
        expect(await signedIn(one)).toBe(401);
      });
    } finally {
      await cleanUp();
    }
  },
);

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.waits-for-date-and-venue-save",
    title: "Log out pressed while Save date and venue is on its way waits for the save, then logs out",
    objective:
      "Confirms (TS-264, PR #114 review) that the Date and venue save is one of the page's saves: with its request held back, Log out neither signs out nor leaves the page; once the save answers, the browser lands on the sign-in page and the new date and venue are saved.",
    expectedOutcome:
      "While the save is held: the address is still the wedding and /auth/me answers 200. After it is let through: the browser is on /login, its /auth/me answers 401, and the second browser reads the new date and venue from the server.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "header-saving");
    const [one, two] = devices;
    try {
      const wedding = await new WeddingDataSetup(one.request).createWedding(uniqueTitle(testInfo.workerIndex, "Saving Log Out Wedding"));
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCFullYear(d.getUTCFullYear() + 2);
      const date = d.toISOString().slice(0, 10);
      const page = await one.newPage();
      const collaborators = new CollaboratorsTabPage(page);
      const header = new SignedInHeader(page);
      await collaborators.goto(wedding.id);
      await collaborators.venueInput().fill("Held Back Hall");

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let saveSeen!: () => void;
      const seen = new Promise<void>((resolve) => (saveSeen = resolve));
      const weddingAddress = new RegExp(`/api/v1/weddings/${wedding.id}$`);
      await page.route(weddingAddress, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        saveSeen();
        await held;
        await route.continue();
      });

      await test.step("Log out while the save is held: still signed in, still on the wedding", async () => {
        await collaborators.pressSaveDateAndVenue(date);
        await seen;
        await header.pressLogOut();
        await expect(page).toHaveURL(new RegExp(`/weddings/${wedding.id}$`));
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Once the save answers, Log out carries on and the date and venue are saved", async () => {
        await Promise.all([page.waitForURL(/\/login/), Promise.resolve().then(release)]);
        expect(await signedIn(one)).toBe(401);
        const saved = ((await (await two.request.get(`/api/v1/weddings/${wedding.id}`)).json()) as {
          wedding: { eventDate: string | null; venueName: string | null };
        }).wedding;
        expect(saved).toMatchObject({ eventDate: date, venueName: "Held Back Hall" });
      });
    } finally {
      await cleanUp();
    }
  },
);

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.typed-venue-asks-first",
    title: "Log out with a venue typed but not saved asks first: Stay keeps it, Leave without saving logs out",
    objective:
      "Confirms (TS-264, PR #114 review) that Date and venue, which only save with their button, count as unsaved while changed: Log out with a new venue typed (Save not pressed) asks 'You have unsaved changes on this tab' instead of logging out; Stay keeps the typed venue and the session; Log out then Leave without saving lands on the sign-in page and the venue was not saved.",
    expectedOutcome:
      "After the first Log out: the question shows, the address is still the wedding and /auth/me answers 200. After Stay: the Venue box still reads 'Typed Not Saved Hall'. After Log out and Leave without saving: /login, /auth/me answers 401, and the second browser reads no venue from the server.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "header-venue");
    const [one, two] = devices;
    try {
      const wedding = await new WeddingDataSetup(one.request).createWedding(uniqueTitle(testInfo.workerIndex, "Typed Venue Wedding"));
      const page = await one.newPage();
      const collaborators = new CollaboratorsTabPage(page);
      const detail = new WeddingDetailPage(page);
      const header = new SignedInHeader(page);
      await collaborators.goto(wedding.id);
      await collaborators.venueInput().fill("Typed Not Saved Hall");

      await test.step("Log out asks first, and nothing is logged out yet", async () => {
        await header.pressLogOut();
        await expect(detail.unsavedChangesPrompt()).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/weddings/${wedding.id}$`));
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Stay keeps the typed venue and the session", async () => {
        await detail.stayOnTab();
        await expect(detail.unsavedChangesPrompt()).toHaveCount(0);
        await expect(collaborators.venueInput()).toHaveValue("Typed Not Saved Hall");
        expect(await signedIn(one)).toBe(200);
      });

      await test.step("Log out, then Leave without saving, logs out without saving the venue", async () => {
        await header.pressLogOut();
        await expect(detail.unsavedChangesPrompt()).toBeVisible();
        await Promise.all([page.waitForURL(/\/login/), detail.leaveTabWithoutSaving()]);
        expect(await signedIn(one)).toBe(401);
        const saved = ((await (await two.request.get(`/api/v1/weddings/${wedding.id}`)).json()) as {
          wedding: { venueName: string | null };
        }).wedding;
        expect(saved.venueName).toBeNull();
      });
    } finally {
      await cleanUp();
    }
  },
);

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.right-after-a-save",
    title: "Log out pressed the moment a guest's name has saved still lands on the sign-in page",
    objective:
      "Confirms (TS-264, PR #114 review) that Log out pressed just as a save-on-leave box's save answers -- while the page is still taking its extra Back history entry off -- signs out and lands on the sign-in page; that Back used to cancel the sign-in page, leaving a signed-out wedding page on screen.",
    expectedOutcome: "The browser ends on /login and /auth/me answers 401.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "header-after-save");
    const [one] = devices;
    try {
      const setup = new WeddingDataSetup(one.request);
      const wedding = await setup.createWedding(uniqueTitle(testInfo.workerIndex, "After Save Wedding"));
      await setup.createGuest(wedding.id, { firstName: "Ann", lastName: "Lee" });
      const page = await one.newPage();
      const guests = new WeddingGuestsPage(page);
      const header = new SignedInHeader(page);
      await guests.goto(wedding.id);
      const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/guests\/[^/]+$/.test(new URL(r.url()).pathname));
      await guests.guestRow("Ann Lee").editFirstName("Anne");
      await saved;
      await Promise.all([page.waitForURL(/\/login/), header.pressLogOut()]);
      expect(await signedIn(one)).toBe(401);
    } finally {
      await cleanUp();
    }
  },
);

defineQualityTest(
  {
    id: "auth.log-out-from-every-signed-in-page.on-a-slow-device-right-after-a-save",
    title: "Log out right after a save on a slow device still lands on the sign-in page (the page's own Back held 300 ms)",
    objective:
      "Confirms (review 14) that when the page's own Back -- taking its extra history entry off just after a save -- lands only after the log-out has answered (as on a slow or busy device; played here by holding history.back() for 300 ms), Log out still lands on the sign-in page. It used to end the session but leave the wedding page, guest names and all, on screen.",
    expectedOutcome: "After saving a guest's first name and pressing Log out at once: the browser is on /login, the wedding's name is no longer on screen, and /auth/me answers 401.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const { devices, signedIn, cleanUp } = await accountOnTwoDevices(browser, testInfo.workerIndex, "header-slow");
    const [one] = devices;
    try {
      const setup = new WeddingDataSetup(one.request);
      const wedding = await setup.createWedding(uniqueTitle(testInfo.workerIndex, "Slow Device Wedding"));
      await setup.createGuest(wedding.id, { firstName: "Ann", lastName: "Lee" });
      const page = await one.newPage();
      // A slow device: the page's own Back lands 300 ms late.
      await delayPagesOwnBack(page, 300);
      const guests = new WeddingGuestsPage(page);
      const header = new SignedInHeader(page);
      await guests.goto(wedding.id);
      const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/guests\/[^/]+$/.test(new URL(r.url()).pathname));
      await guests.guestRow("Ann Lee").editFirstName("Anne");
      await saved;
      await Promise.all([page.waitForURL(/\/login/, { timeout: 10_000 }), header.pressLogOut()]);
      await expect(new WeddingDetailPage(page).textLocator(wedding.name)).toHaveCount(0);
      expect(await signedIn(one)).toBe(401);
    } finally {
      await cleanUp();
    }
  },
);
