/**
 * TS-142 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — "Forgot password?". Tom found there was no way back
 * into an account whose password was forgotten. Now the sign-in page links to a request form that
 * emails a single-use link, valid for 1 hour, to choose a new password.
 *
 * An email with no account gets a plain "no account for that email" message (Tom's decision,
 * 2026-10-02) and nothing is created or sent for it. Asking again cancels older links. A used, expired or made-up link says so. Requests for one
 * email are rate-limited. Tests never send real email: CI and local dev only log it, and the link
 * a test opens is planted in the test database (only its hash is stored, as the app does).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { plantPasswordResetToken, usableResetTokenCount } from "../support/testDatabase.js";
import { PasswordResetPages } from "../pages/PasswordResetPages.js";

const SENT = /^We've sent a link to reset your password\. It works for 1 hour\./;

defineQualityTest(
  {
    id: "authentication.forgot-password-resets-with-a-single-use-emailed-link.request-reset-reuse-expiry-limits",
    title: "a forgotten password can be reset from the sign-in page with a single-use, 1-hour emailed link; an email with no account is told so",
    objective:
      "Confirms the sign-in page links to Forgot password; that requesting a reset for a registered email says the link was sent and creates one usable link, while an unknown email is told there's no account (with a Sign up link) and nothing is created; that asking again cancels the older link; that the link sets a new password and signs the person in, after which the old password fails, the new one works and the link can't be used again; that mismatched passwords are caught; that an expired or made-up link says it's no longer valid; and that a fourth request for one email within 15 minutes is refused.",
    expectedOutcome:
      "The registered email shows the sent message and has exactly 1 usable link; the unknown one shows the no-account message and an older planted one stops working. The link lands on the dashboard; the old password's login fails and the new one's succeeds; reopening the link, an expired link and a made-up link each show 'This reset link is no longer valid — request a new one.'. Mismatched passwords show 'The two passwords don't match.'. The fourth request returns 429.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    // Its own made-up network address, like the other rate-limit specs, so repeated local runs
    // (all from one machine) never use up each other's per-address allowance.
    const address = `203.0.113.${Math.floor(Math.random() * 254) + 1}-${Date.now()}`;
    const visitor = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": address } });
    try {
      const token = uniqueToken(testInfo.workerIndex);
      const email = `pw-tester-reset-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
      const oldPassword = `old-${token}-password`;
      const newPassword = `new-${token}-password`;
      const signup = await visitor.request.post("/api/v1/auth/signup", {
        data: { name: `Playwright Tester reset ${token}`, email, password: oldPassword },
      });
      expect(signup.ok()).toBe(true);
      await visitor.clearCookies();
      const pages = new PasswordResetPages(await visitor.newPage());
      const login = (password: string) => visitor.request.post("/api/v1/auth/login", { data: { email, password } });

      await test.step("The sign-in page links to Forgot password; a real account gets a link, an unknown email is told there's no account", async () => {
        await pages.gotoLogin();
        await pages.openForgotPasswordFromLogin();
        await pages.requestReset(email);
        await expect(pages.confirmation()).toHaveText(SENT);
        expect(await usableResetTokenCount(email)).toBe(1);

        await pages.gotoForgotPassword();
        await pages.requestReset(`nobody-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`);
        await expect(pages.noAccountMessage()).toBeVisible();
        await expect(pages.noAccountMessage().getByRole("link", { name: "Sign up" })).toBeVisible();
        await expect(pages.confirmation()).toHaveCount(0);
      });

      let link = "";
      await test.step("Asking again cancels the older link", async () => {
        const older = await plantPasswordResetToken(email);
        const again = await visitor.request.post("/api/v1/auth/forgot-password", { data: { email } });
        expect(again.ok()).toBe(true);
        expect(await usableResetTokenCount(email)).toBe(1);
        await pages.gotoResetLink(older);
        await expect(pages.noLongerValid()).toBeVisible();
        link = await plantPasswordResetToken(email);
      });

      await test.step("Mismatched passwords are caught", async () => {
        await pages.gotoResetLink(link);
        await pages.chooseNewPassword(newPassword, `${newPassword}x`);
        await expect(pages.message("The two passwords don't match.")).toBeVisible();
      });

      await test.step("The link sets the new password and signs the person in; it can't be used twice", async () => {
        await pages.chooseNewPassword(newPassword);
        await pages.waitForDashboard();
        expect((await visitor.request.get("/api/v1/auth/me")).ok()).toBe(true);

        expect((await login(oldPassword)).ok()).toBe(false);
        expect((await login(newPassword)).ok()).toBe(true);

        await pages.gotoResetLink(link);
        await expect(pages.noLongerValid()).toBeVisible();
      });

      await test.step("An expired link and a made-up link are no longer valid", async () => {
        await pages.gotoResetLink(await plantPasswordResetToken(email, { expired: true }));
        await expect(pages.noLongerValid()).toBeVisible();
        await pages.gotoResetLink("f".repeat(64));
        await expect(pages.noLongerValid()).toBeVisible();
        const refused = await visitor.request.post(`/api/v1/auth/reset-password/${"f".repeat(64)}`, { data: { password: "whatever-123" } });
        expect(refused.status()).toBe(400);
      });

      await test.step("A fourth request for one email within 15 minutes is refused", async () => {
        const target = `pw-tester-flood-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
        for (let i = 0; i < 3; i++) {
          expect((await visitor.request.post("/api/v1/auth/forgot-password", { data: { email: target } })).ok()).toBe(true);
        }
        expect((await visitor.request.post("/api/v1/auth/forgot-password", { data: { email: target } })).status()).toBe(429);
      });
    } finally {
      await visitor.close();
    }
  },
);
