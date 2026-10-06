/**
 * TS-179 (REQ-ACCOUNT-WEDDING-MANAGEMENT) — Tom's decision, 2026-10-06: someone can sign up with an
 * address that isn't theirs, and the real owner of that address then gets the "confirm your email"
 * link. The confirm page now tells them not to confirm an account they didn't create, and to use
 * Forgot password on the sign-in page to take it over instead. Opening the page confirms nothing.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { VerifyEmailPage } from "../pages/VerifyEmailPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { plantEmailVerificationToken, testAccountEmailConfirmed } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "authentication.confirm-page-warns-when-the-account-isnt-yours.warning-and-forgot-password-link",
    title: "the confirm-your-email page warns not to confirm an account you didn't create, and links to Forgot password",
    objective:
      "Confirms that the page an emailed confirmation link opens shows, next to the Confirm button, the warning not to confirm an account you didn't create and to use Forgot password on the sign-in page instead; that just opening the page leaves the address unconfirmed; and that the warning's Forgot password link opens the reset request form.",
    expectedOutcome:
      "The warning text is visible beside 'Confirm my email'. The account is still unconfirmed after the page is opened. The Forgot password link lands on /forgot-password with its 'Send reset link' form.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    const someone = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "squatter", { confirmEmail: false });
    const token = await plantEmailVerificationToken(someone.email);
    // The address's real owner opens the link in their own, signed-out browser.
    const owner = await browser.newContext();
    try {
      const verify = new VerifyEmailPage(await owner.newPage());

      await test.step("The confirm page warns before anything is confirmed", async () => {
        await verify.goto(token);
        await expect(verify.confirmButton()).toBeVisible();
        await expect(verify.notYourAccountWarning()).toContainText(
          "If you didn't create this Seatwise account, don't confirm — use Forgot password on the sign-in page to take it over instead.",
        );
        expect(await testAccountEmailConfirmed(someone.email)).toBe(false);
      });

      await test.step("Its Forgot password link opens the reset request form", async () => {
        await verify.followForgotPassword();
      });
    } finally {
      await owner.close();
      await someone.context.close();
    }
  },
);
