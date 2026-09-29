/**
 * TS-113 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-NON-FUNCTIONAL) — sign-in is rate-limited on FAILED
 * attempts (apps/web/src/lib/rate-limit.ts LOGIN_LIMITS): 10 per account and 30 per network address
 * per 15 minutes. A successful sign-in never counts, so real use can't lock anyone out; once an
 * account is over the limit, even its right password waits out the window, so the limit can't
 * reveal which guess was correct.
 *
 * Each step uses its own made-up network address (x-forwarded-for) and its own account, so this
 * neither trips nor is tripped by any other test.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { LoginPage } from "../pages/LoginPage.js";
import { uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";

const FAILURES_PER_ACCOUNT = 10;
const FAILURES_PER_ADDRESS = 30;

function uniqueAddress(): string {
  return `198.51.100.${Math.floor(Math.random() * 254) + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

defineQualityTest(
  {
    id: "auth.repeated-failed-sign-ins-are-rate-limited.per-account-per-address-and-page-message",
    title: "repeated failed sign-ins are refused per account and per address — even with the right password once over the limit — while successful sign-ins never count and other accounts are unaffected",
    objective:
      "Confirms successful sign-ins don't count toward the limit; that after 10 wrong passwords an account is refused with 429 and Retry-After even for its correct password, while another account is unaffected; that 30 failed sign-ins from one address block further attempts from it but not from another address; and that the login page shows the wait message.",
    expectedOutcome:
      "12 successful sign-ins in a row all succeed. Wrong passwords 1–10 return 401, the 11th attempt (right password) returns 429 with Retry-After, and a different account still signs in. 30 failures from one address, then the 31st attempt from it returns 429 while another address gets a normal 401. The login page opened from the limited address shows 'Too many sign-in attempts'.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ playwright, browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const client = (address: string) => playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": address } });
    const newAccount = async () => {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      // Generated for this test only and never logged or attached.
      const password = randomBytes(16).toString("base64url");
      const c = await client(uniqueAddress());
      expect((await c.post("/api/v1/auth/signup", { data: { name: `Playwright Tester ${token}`, email, password } })).status()).toBe(201);
      await c.dispose();
      return { email, password };
    };

    await test.step("Successful sign-ins never count: 12 in a row all succeed", async () => {
      const { email, password } = await newAccount();
      const c = await client(uniqueAddress());
      try {
        for (let i = 1; i <= FAILURES_PER_ACCOUNT + 2; i++) {
          expect((await c.post("/api/v1/auth/login", { data: { email, password } })).status(), `sign-in ${i}`).toBe(200);
        }
      } finally {
        await c.dispose();
      }
    });

    await test.step("Per account: after 10 wrong passwords, even the right one is refused -- and another account is unaffected", async () => {
      const target = await newAccount();
      const bystander = await newAccount();
      const c = await client(uniqueAddress());
      try {
        for (let i = 1; i <= FAILURES_PER_ACCOUNT; i++) {
          expect((await c.post("/api/v1/auth/login", { data: { email: target.email, password: "wrong-password" } })).status(), `failure ${i}`).toBe(401);
        }
        const refused = await c.post("/api/v1/auth/login", { data: target });
        expect(refused.status()).toBe(429);
        expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
        expect((await c.post("/api/v1/auth/login", { data: bystander })).status()).toBe(200);
      } finally {
        await c.dispose();
      }
    });

    const limitedAddress = uniqueAddress();
    await test.step("Per address: 30 failures across many accounts block that address, not another", async () => {
      const flooding = await client(limitedAddress);
      const someoneElse = await client(uniqueAddress());
      try {
        for (let i = 1; i <= FAILURES_PER_ADDRESS; i++) {
          const email = `nobody-${i}-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
          expect((await flooding.post("/api/v1/auth/login", { data: { email, password: "guess" } })).status(), `failure ${i}`).toBe(401);
        }
        const probe = { email: `nobody-probe${TEST_ACCOUNT_EMAIL_DOMAIN}`, password: "guess" };
        expect((await flooding.post("/api/v1/auth/login", { data: probe })).status()).toBe(429);
        expect((await someoneElse.post("/api/v1/auth/login", { data: probe })).status()).toBe(401);
      } finally {
        await flooding.dispose();
        await someoneElse.dispose();
      }
    });

    await test.step("Page: signing in from the limited address shows the wait message", async () => {
      const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": limitedAddress } });
      try {
        const loginPage = new LoginPage(await context.newPage());
        await loginPage.goto();
        await loginPage.login(`nobody-page${TEST_ACCOUNT_EMAIL_DOMAIN}`, "guess");
        await loginPage.expectError("Too many sign-in attempts");
      } finally {
        await context.close();
      }
    });
  },
);
