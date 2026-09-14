/**
 * TS-37 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — the signup/login/logout/session-cookie coverage the
 * Jira story calls for explicitly, beyond the workbook's own AC-004..AC-011 rows (none of which
 * happen to cover plain signup/login/logout as their own scenario). Deliberately drives the
 * signup and login forms through the real UI rather than the framework's `account`/`signUpFreshAccount`
 * fixture -- that fixture exists so *other* tests can treat account creation as scaffolding, but
 * signup and login are themselves the behavior under test here, so this test intentionally does
 * not use it.
 *
 * Also exercises the session cookie the app actually authenticates with (`seatwise_token`, an
 * httpOnly cookie -- see e2e/support/auth.ts's own doc comment on why this framework never reads
 * or stores a token itself): present after signup and after login, gone after logout.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { uniqueToken } from "../data/ids.js";

const AUTH_COOKIE_NAME = "seatwise_token";

async function hasAuthCookie(context: { cookies(): Promise<{ name: string }[]> }): Promise<boolean> {
  const cookies = await context.cookies();
  return cookies.some((c) => c.name === AUTH_COOKIE_NAME);
}

defineQualityTest(
  {
    id: "auth.signup-login-logout.full-flow",
    title: "a new user can sign up, log out, and log back in with the same credentials",
    objective:
      "Confirms the signup form creates a working account and lands the user on their dashboard, that logging out clears the session, and that logging back in with the same email/password re-establishes it.",
    expectedOutcome:
      "Signup and login each land on the dashboard with the seatwise_token session cookie present; logging out returns to /login with that cookie gone.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:critical", "@suite:smoke", "@suite:regression"],
  },
  async ({ signupPage, loginPage, page, context, evidence }, testInfo) => {
    const dashboardPage = new DashboardPage(page);
    // Generated fresh for this one signup and never logged, attached, or reused beyond this
    // test's own login step below -- matching e2e/support/auth.ts's own handling of a test
    // account's password.
    const token = uniqueToken(testInfo.workerIndex);
    const name = `Playwright Tester ${token}`;
    const email = `pw-tester-${token}@example.invalid`;
    const password = randomBytes(16).toString("base64url");

    await test.step("Arrange: open the signup page", async () => {
      await signupPage.goto();
    });

    await test.step("Act: submit the signup form", async () => {
      await signupPage.signUp(name, email, password);
    });

    await test.step("Assert: signup lands on the dashboard with a session cookie set", async () => {
      await page.waitForURL("/dashboard");
      await expect(dashboardPage.textLocator(`Signed in as ${name}`)).toBeVisible();
      expect(await hasAuthCookie(context)).toBe(true);
    });

    await test.step("Act: log out", async () => {
      await dashboardPage.logout();
    });

    await test.step("Assert: logout returns to the login page and clears the session cookie", async () => {
      await page.waitForURL("/login");
      expect(await hasAuthCookie(context)).toBe(false);
    });

    await test.step("Act: log back in with the same email and password", async () => {
      await loginPage.login(email, password);
    });

    await test.step("Assert: login re-establishes the dashboard session", async () => {
      await page.waitForURL("/dashboard");
      await expect(dashboardPage.textLocator(`Signed in as ${name}`)).toBeVisible();
      expect(await hasAuthCookie(context)).toBe(true);
    });

    await evidence.checkpoint(
      "logged-back-in",
      `${name} is back on their dashboard after signing up, logging out, and logging back in with the same credentials.`,
    );
  },
);
