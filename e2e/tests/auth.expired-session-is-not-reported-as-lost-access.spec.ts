/**
 * TS-109 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-ACCESS-CONTROL) — a session that expires while a
 * wedding is open must be reported as an expired session, not as revoked access, and signing back
 * in must return the planner to the wedding they were on.
 *
 * Before TS-109, the wedding page's FR-1.6 access poll treated a 401 exactly like a 404: it showed
 * "Your access to this wedding has been removed.", unmounted every tab (losing anything in
 * progress) and bounced to /dashboard, then /login, with no way back to the wedding afterwards.
 *
 * Expiry is simulated by clearing the browser context's cookies while the page is open -- from the
 * app's side that is indistinguishable from the auth cookie reaching its expiry: every subsequent
 * request arrives with no session. This test signs up its own account (rather than using the
 * `account` fixture) because it has to sign back in with that account's password, which the
 * fixture deliberately never keeps.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { LoginPage } from "../pages/LoginPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";

defineQualityTest(
  {
    id: "auth.expired-session-is-not-reported-as-lost-access.notice-and-return-after-sign-in",
    title: "a session that expires on an open wedding shows a session-expired notice (never 'access removed'), keeps the page, and signing back in returns to that wedding",
    objective:
      "Confirms that when the session disappears while a wedding page is open, the page stays mounted and shows the app-wide session-expired notice instead of the access-revoked message or a redirect; that the notice's sign-in link brings the planner straight back to the same wedding; and that the login page never follows a ?next= pointing off-site.",
    expectedOutcome:
      "Within one access-poll interval the session-expired notice is visible, the access-removed message never appears, and the wedding heading and URL are unchanged. Signing in from the notice lands on /weddings/:id with the notice gone. Logging in with ?next=//evil.example lands on /dashboard.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ weddingData, loginPage, context, page }, testInfo) => {
    const detailPage = new WeddingDetailPage(page);
    // Generated for this test only and never logged or attached -- same handling as
    // auth.signup-login-logout.spec.ts.
    const token = uniqueToken(testInfo.workerIndex);
    const email = `pw-tester-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
    const password = randomBytes(16).toString("base64url");
    let weddingId = "";
    let weddingName = "";

    await test.step("Arrange: sign up (switching this context's session to the new account) and open a wedding", async () => {
      const res = await context.request.post("/api/v1/auth/signup", {
        data: { name: `Playwright Tester ${token}`, email, password },
      });
      expect(res.ok()).toBe(true);
      const wedding = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Session Wedding"));
      weddingId = wedding.id;
      weddingName = wedding.name;

      await detailPage.goto(weddingId);
      await expect(detailPage.heading()).toHaveText(weddingName);
    });

    await test.step("Act: the session disappears while the wedding is open", async () => {
      await context.clearCookies();
    });

    await test.step("Assert: a session-expired notice, never 'access removed', and the page stays put", async () => {
      // The FR-1.6 access poll runs every 4s -- its first post-expiry tick is what surfaces this.
      await expect(detailPage.sessionExpiredNotice()).toBeVisible({ timeout: 10_000 });
      await expect(detailPage.accessRemovedMessage()).toHaveCount(0);
      await expect(detailPage.heading()).toHaveText(weddingName);
      expect(new URL(page.url()).pathname).toBe(`/weddings/${weddingId}`);
    });

    await test.step("Act + Assert: signing in from the notice's link (a new tab) returns there to the same wedding, and this page picks up the session", async () => {
      // TS-170: the link opens a new tab, so this page -- and anything typed on it -- stays put.
      const tab = await detailPage.clickSignInAgain();
      await tab.waitForURL((url) => url.pathname === "/login" && url.searchParams.get("next") === `/weddings/${weddingId}`);
      await new LoginPage(tab).login(email, password);
      await tab.waitForURL(`/weddings/${weddingId}`);
      await expect(new WeddingDetailPage(tab).heading()).toHaveText(weddingName);
      await tab.close();
      expect(new URL(page.url()).pathname).toBe(`/weddings/${weddingId}`);
      await expect(detailPage.sessionExpiredNotice()).toHaveCount(0, { timeout: 10_000 });
    });

    await test.step("Assert: the login page never follows a ?next= that points off-site", async () => {
      await page.goto("/login?next=//evil.example/steal");
      await loginPage.login(email, password);
      await page.waitForURL("/dashboard");
    });
  },
);
