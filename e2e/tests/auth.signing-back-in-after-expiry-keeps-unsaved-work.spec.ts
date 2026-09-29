/**
 * TS-94 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-NON-FUNCTIONAL) — "if a session does expire,
 * in-progress edits should not be lost."
 *
 * TS-94's sliding renewal (apps/web/src/proxy.ts, unit-tested in
 * apps/web/src/lib/session-renewal.test.mts) keeps an *active* session from expiring at all. This
 * covers the remaining case -- a session that does end (30 days idle, the 90-day re-sign-in limit,
 * or cleared cookies) while work is on screen: the planner signs back in from the session-expired
 * notice itself, without leaving the page, and whatever they had typed but not yet saved is still
 * there and can then be saved normally.
 *
 * Expiry is simulated by clearing the context's cookies (see
 * auth.expired-session-is-not-reported-as-lost-access.spec.ts for why that's equivalent). Signs up
 * its own account because it must sign back in with that account's password.
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueTitle, uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";

defineQualityTest(
  {
    id: "auth.signing-back-in-after-expiry-keeps-unsaved-work.inline-sign-in",
    title: "after a session expires mid-edit, signing back in from the notice keeps the page and its unsaved input, and the edit then saves",
    objective:
      "Confirms a planner whose session expires with a half-filled add-guest form can sign back in from the session-expired notice without leaving or reloading the page, that the half-typed value survives, and that finishing the form afterwards saves normally.",
    expectedOutcome:
      "The notice appears after expiry; signing in from it hides the notice with the URL unchanged and the typed first name still in its field; submitting the form then adds the guest and the save status reads 'All changes saved'.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:authentication", "@risk:high", "@suite:regression"],
  },
  async ({ weddingData, weddingGuestsPage, context, page }, testInfo) => {
    const detailPage = new WeddingDetailPage(page);
    // Generated for this test only and never logged or attached.
    const token = uniqueToken(testInfo.workerIndex);
    const email = `pw-tester-${token}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
    const password = randomBytes(16).toString("base64url");
    const halfTyped = `Halfway${token.replace(/[^a-zA-Z]/g, "").slice(0, 6)}`;
    let weddingId = "";

    await test.step("Arrange: signed in on a wedding's Guests tab, with a new guest half-typed and not saved", async () => {
      const res = await context.request.post("/api/v1/auth/signup", {
        data: { name: `Playwright Tester ${token}`, email, password },
      });
      expect(res.ok()).toBe(true);
      const wedding = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Reauth Wedding"));
      weddingId = wedding.id;
      await weddingGuestsPage.goto(weddingId);
      await weddingGuestsPage.openGuestsTab();
      await weddingGuestsPage.typeNewGuestFirstName(halfTyped);
    });

    await test.step("Act: the session disappears", async () => {
      await context.clearCookies();
      await expect(detailPage.sessionExpiredNotice()).toBeVisible({ timeout: 10_000 });
    });

    await test.step("Act + Assert: signing in from the notice keeps the page and the half-typed input", async () => {
      await detailPage.signInFromSessionNotice(email, password);
      await expect(detailPage.sessionExpiredNotice()).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(`/weddings/${weddingId}`);
      expect(await weddingGuestsPage.newGuestFirstName()).toBe(halfTyped);
    });

    await test.step("Act + Assert: finishing the form now saves normally", async () => {
      await weddingGuestsPage.finishAddingGuest("Afterexpiry");
      await weddingGuestsPage.guestRow(`${halfTyped} Afterexpiry`).expectVisible();
      await expect(detailPage.saveStatus()).toHaveText("All changes saved");
    });
  },
);
