/**
 * TS-204 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — "Delete my account" whose answer is lost is retried.
 * If the retry finds this browser signed out, that used to be taken as "deleted" -- but the session
 * may simply have ended (logged out in another tab, a password reset) while the first try never
 * arrived. Now only "this account no longer exists" counts as deleted; otherwise the person is told
 * to sign in to check.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { uniqueTestAddress, uniqueToken } from "../data/ids.js";

const UNCONFIRMED =
  "You were signed out before we could confirm whether your account was deleted. Sign in to check — if your account still exists, you can delete it from there.";
const ACCOUNT_PATH = "/api/v1/auth/me";

defineQualityTest(
  {
    id: "account-management.a-retried-account-delete-says-what-really-happened.signed-out-elsewhere-vs-really-deleted",
    title: "a retried account delete says 'sign in to check' when the session ended elsewhere, and 'deleted' only when it was",
    objective:
      "Confirms (TS-204) that when the first Delete my account request is lost and this browser was logged out in the meantime, the Account page says to sign in to check and the account still exists; and that when the first request did delete the account but its answer was lost, the page says the account has been deleted.",
    expectedOutcome:
      "Case 1: the page shows the 'sign in to check' message, never 'Your account has been deleted', and signing in with the same password still works (200). Case 2: the page shows 'Your account has been deleted' and signing in fails (401).",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:high", "@suite:regression"],
  },
  async ({ browser, playwright, baseURL }, testInfo) => {
    const newSignedInBrowser = async () => {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-delretry-${token}@example.invalid`;
      const password = randomBytes(16).toString("base64url");
      const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      expect((await context.request.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).status()).toBe(201);
      return { context, email, password };
    };
    const canSignIn = async (email: string, password: string) => {
      const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      try {
        return (await api.post("/api/v1/auth/login", { data: { email, password } })).status();
      } finally {
        await api.dispose();
      }
    };

    await test.step("Signed out elsewhere while the first try was lost: 'sign in to check', and the account is still there", async () => {
      const { context, email, password } = await newSignedInBrowser();
      try {
        const page = await context.newPage();
        const account = new AccountPage(page);
        await account.goto();
        let lost = 0;
        await page.route(`**${ACCOUNT_PATH}`, async (route) => {
          if (route.request().method() !== "DELETE" || lost > 0) return route.fallback();
          lost++;
          // This browser is logged out (another tab) before the request ever arrives.
          await context.request.post("/api/v1/auth/logout", { data: {} });
          return route.abort("connectionfailed");
        });
        await account.deleteAccount(password);
        await expect(account.message(UNCONFIRMED)).toBeVisible();
        await expect(account.deletedHeading()).toHaveCount(0);
        expect(await canSignIn(email, password)).toBe(200);
      } finally {
        await context.close();
      }
    });

    await test.step("Really deleted, only the answer lost: 'Your account has been deleted'", async () => {
      const { context, email, password } = await newSignedInBrowser();
      try {
        const page = await context.newPage();
        const account = new AccountPage(page);
        await account.goto();
        const sessionToken = (await context.cookies()).find((c) => c.name === "seatwise_token")!.value;
        let lost = 0;
        await page.route(`**${ACCOUNT_PATH}`, async (route) => {
          if (route.request().method() !== "DELETE" || lost > 0) return route.fallback();
          lost++;
          // The first try reaches the server and deletes the account; its answer never comes back.
          const same = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `seatwise_token=${sessionToken}` } });
          try {
            expect((await same.delete(ACCOUNT_PATH, { data: { password } })).status()).toBe(200);
          } finally {
            await same.dispose();
          }
          return route.abort("connectionfailed");
        });
        await account.deleteAccount(password);
        await expect(account.deletedHeading()).toBeVisible();
        expect(await canSignIn(email, password)).toBe(401);
      } finally {
        await context.close();
      }
    });
  },
);
