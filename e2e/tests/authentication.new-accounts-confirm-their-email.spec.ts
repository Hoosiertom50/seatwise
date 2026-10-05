/**
 * TS-164 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — Tom's decision, 2026-10-05: everyone confirms their
 * email address at sign-up. A new account works straight away, but until its owner clicks the link
 * emailed to them, Seatwise won't send invites or RSVP emails for it, and it can't accept an invite
 * (anyone could have signed up with that address). A banner says so and offers a fresh link. A
 * password reset also confirms the address, since it's proof of the same thing.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { VerifyEmailPage } from "../pages/VerifyEmailPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import {
  inviteToken,
  plantEmailVerificationToken,
  plantPasswordResetToken,
  testAccountEmailConfirmed,
} from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "authentication.new-accounts-confirm-their-email.limits-until-confirmed-then-unlocked",
    title: "a new account can't send invites or RSVP emails, or accept an invite, until it confirms its email; the link (or a password reset) confirms it",
    objective:
      "Confirms that a freshly signed-up account reports emailVerified false and sees the reminder banner; that its invite is refused (403) and adding a guest with an email doesn't email them; that accepting an invite to its address is refused with EMAIL_NOT_VERIFIED; that Resend link works then is limited; that the emailed link's page confirms the address after a click, after which the banner is gone, invites send and the invite can be accepted; that a used link is refused; and that a password reset confirms an unconfirmed address.",
    expectedOutcome:
      "emailVerified false and the banner visible. Invite 403 with 'Confirm your email address first'. Guest add returns rsvpEmail.confirmEmailFirst true and emailed false. Accept 403 with status EMAIL_NOT_VERIFIED. Resend 200 three times, then 429. After confirming: 'your email address is confirmed', emailVerified true, no banner, invite 201, accept 200. Re-using the link shows an error. After a password reset, the second account is confirmed.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ weddingData, browser, playwright }, testInfo) => {
    test.setTimeout(90_000);
    const fresh = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "unconfirmed", { confirmEmail: false });
    const later = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "resetter", { confirmEmail: false });
    const page = await fresh.context.newPage();
    const req = fresh.context.request;
    const me = async () => ((await (await req.get("/api/v1/auth/me")).json()) as { user: { emailVerified: boolean } }).user;
    const verify = new VerifyEmailPage(page);

    try {
      await test.step("A new account starts unconfirmed, with a reminder", async () => {
        expect((await me()).emailVerified).toBe(false);
        await new DashboardPage(page).goto();
        await expect(verify.reminderBanner()).toBeVisible();
      });

      const w = ((await (await req.post("/api/v1/weddings", { data: { name: uniqueTitle(testInfo.workerIndex, "Unconfirmed") } })).json()) as {
        wedding: { id: string };
      }).wedding.id;

      await test.step("Until confirmed: no invites, no RSVP emails", async () => {
        const invite = await req.post(`/api/v1/weddings/${w}/invites`, {
          data: { email: `pw-invitee-${Date.now()}@example.invalid`, permissionLevel: "VIEW", role: "COLLABORATOR" },
        });
        expect(invite.status()).toBe(403);
        expect(((await invite.json()) as { error: string }).error).toContain("Confirm your email address first");
        const guest = await req.post(`/api/v1/weddings/${w}/guests`, {
          data: { ...uniquePersonName(testInfo.workerIndex), email: `pw-guest-${Date.now()}@example.invalid` },
        });
        expect(guest.status()).toBe(201);
        const body = (await guest.json()) as { rsvpEmail: { emailed: boolean; confirmEmailFirst: boolean } };
        expect(body.rsvpEmail).toMatchObject({ emailed: false, confirmEmailFirst: true });
      });

      // An invite to the unconfirmed address, from a confirmed owner.
      const owned = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Invites Unconfirmed"));
      const sent = await weddingData.createInvite(owned.id, fresh.email, "VIEW");
      expect(sent.status).toBe(201);
      const token = await inviteToken(sent.body.invite!.id);

      await test.step("Until confirmed: an invite to this address can't be accepted", async () => {
        const accept = await req.post(`/api/v1/invites/${token}/accept`, { data: {} });
        expect(accept.status()).toBe(403);
        expect(((await accept.json()) as { status: string }).status).toBe("EMAIL_NOT_VERIFIED");
      });

      await test.step("Resend link works, a few times, then waits", async () => {
        for (let i = 1; i <= 3; i++) expect((await req.post("/api/v1/auth/verification-email", { data: {} })).status(), `resend ${i}`).toBe(200);
        expect((await req.post("/api/v1/auth/verification-email", { data: {} })).status()).toBe(429);
      });

      const link = await plantEmailVerificationToken(fresh.email);
      await test.step("The emailed link confirms the address after a click, and everything unlocks", async () => {
        await verify.goto(link);
        await verify.confirmButton().click();
        await expect(verify.confirmedMessage()).toBeVisible();
        expect((await me()).emailVerified).toBe(true);
        await new DashboardPage(page).goto();
        await expect(verify.reminderBanner()).toHaveCount(0);
        const invite = await req.post(`/api/v1/weddings/${w}/invites`, {
          data: { email: `pw-invitee-${Date.now()}@example.invalid`, permissionLevel: "VIEW", role: "COLLABORATOR" },
        });
        expect(invite.status()).toBe(201);
        expect((await req.post(`/api/v1/invites/${token}/accept`, { data: {} })).status()).toBe(200);
      });

      await test.step("A used link is refused", async () => {
        await verify.goto(link);
        await verify.confirmButton().click();
        await expect(verify.errorMessage()).toContainText("expired or has already been used");
      });

      await test.step("A password reset also confirms the address", async () => {
        expect(await testAccountEmailConfirmed(later.email)).toBe(false);
        const resetToken = await plantPasswordResetToken(later.email);
        const visitor = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
        try {
          const res = await visitor.post(`/api/v1/auth/reset-password/${resetToken}`, { data: { password: "a-brand-new-passphrase" } });
          expect(res.ok()).toBe(true);
        } finally {
          await visitor.dispose();
        }
        expect(await testAccountEmailConfirmed(later.email)).toBe(true);
      });
    } finally {
      await fresh.context.close();
      await later.context.close();
    }
  },
);
