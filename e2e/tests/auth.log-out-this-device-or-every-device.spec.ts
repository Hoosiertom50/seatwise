/**
 * TS-204 (REQ-ACCOUNT-WEDDING-MANAGEMENT, Tom's decision) — "Log out" signs out this device only;
 * "Log out on all devices" on the Account page signs out every device. Before, Log out on a phone
 * signed the laptop out too. A password reset still signs out everywhere (covered in
 * auth.sessions-end-on-reset-and-log-out).
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { AccountPage } from "../pages/AccountPage.js";
import { uniqueTestAddress, uniqueToken } from "../data/ids.js";

defineQualityTest(
  {
    id: "auth.log-out-this-device-or-every-device.dashboard-log-out-then-account-log-out-everywhere",
    title: "Log out on the dashboard signs out only that browser; Log out on all devices signs out every browser",
    objective:
      "Confirms (TS-204) that with one account signed in on three browsers, pressing Log out on the first browser's dashboard lands it on the sign-in page and its own session is over, while the second and third stay signed in; and that pressing Log out on all devices on the second browser's Account page lands it on the sign-in page and signs the third browser out too.",
    expectedOutcome:
      "After Log out in browser 1: browser 1 is on /login and its /auth/me answers 401 (SESSION_ENDED for its saved token); browsers 2 and 3 answer 200. After Log out on all devices in browser 2: browser 2 is on /login, and browsers 2 and 3 answer 401.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright, baseURL }, testInfo) => {
    const token = uniqueToken(testInfo.workerIndex);
    const email = `pw-tester-logout-${token}@example.invalid`;
    const password = randomBytes(16).toString("base64url");
    const setup = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    expect((await setup.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).status()).toBe(201);
    await setup.dispose();

    // Three separate sign-ins of the same account -- three devices.
    const devices = await Promise.all(
      [1, 2, 3].map(async () => {
        const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
        expect((await ctx.request.post("/api/v1/auth/login", { data: { email, password } })).status()).toBe(200);
        return ctx;
      }),
    );
    const [one, two, three] = devices;
    const signedIn = async (ctx: (typeof devices)[number]) => (await ctx.request.get("/api/v1/auth/me")).status();

    try {
      await test.step("Log out on browser 1's dashboard signs out browser 1 only", async () => {
        const savedToken = (await one.cookies()).find((c) => c.name === "seatwise_token")!.value;
        const page = await one.newPage();
        const dashboard = new DashboardPage(page);
        await dashboard.goto();
        await dashboard.logout();
        await page.waitForURL(/\/login/);
        expect(await signedIn(one)).toBe(401);
        // Its token, used directly, is ended -- not just the cookie cleared.
        const direct = await playwright.request.newContext({ baseURL });
        try {
          const res = await direct.get("/api/v1/auth/me", { headers: { authorization: `Bearer ${savedToken}` } });
          expect(res.status()).toBe(401);
          expect(((await res.json()) as { code?: string }).code).toBe("SESSION_ENDED");
        } finally {
          await direct.dispose();
        }
        expect(await signedIn(two)).toBe(200);
        expect(await signedIn(three)).toBe(200);
      });

      await test.step("Log out on all devices on browser 2's Account page signs out browsers 2 and 3", async () => {
        const page = await two.newPage();
        const account = new AccountPage(page);
        await account.goto();
        await expect(account.logOutEverywhereButton()).toBeVisible();
        await account.logOutEverywhere();
        expect(await signedIn(two)).toBe(401);
        expect(await signedIn(three)).toBe(401);
      });
    } finally {
      await Promise.all(devices.map((d) => d.close()));
    }
  },
);
