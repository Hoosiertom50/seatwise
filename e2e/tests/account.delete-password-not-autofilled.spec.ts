/**
 * TS-271 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-NON-FUNCTIONAL) — Firefox filled a saved password into
 * the "Delete my account" box as the Account page opened, so leaving the page asked about a password
 * nobody had typed (and the delete's "type your password" safeguard was gone). The box now asks
 * browsers not to fill it, and only takes a value once the person has been in the box (focused it or dropped onto it).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { watchBrowserQuestions } from "../support/browserQuestions.js";

defineQualityTest(
  {
    id: "account.delete-password-not-autofilled.browser-fill-ignored",
    title: "a password a browser fills into Delete my account isn't taken, and leaving the page asks nothing",
    objective:
      "Confirms (TS-271) that the Account page's 'Your password' box asks browsers not to fill it, that a value put there the way a password manager does (no focus, no key presses) is not taken -- the box stays empty and Delete my account stays off -- and that a reload, '← Back to your weddings' and the browser's Back then go straight to the dashboard with no question; while a typed password still counts.",
    expectedOutcome:
      "The box has autocomplete=off. After the simulated fill: the box is empty and Delete my account is disabled; a reload asks nothing; Back to your weddings and the browser's Back land on /dashboard with no question. After typing a password: Delete my account is enabled.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const accountPage = new AccountPage(page);
    await new DashboardPage(page).goto();
    await accountPage.goto();
    await expect(accountPage.deletePasswordInput()).toHaveAttribute("autocomplete", "off");

    await accountPage.autofillDeletePassword("a-saved-password");
    await expect(accountPage.deletePasswordInput()).toHaveValue("");
    await expect(accountPage.deleteAccountButton()).toBeDisabled();

    await test.step("Reload asks nothing", async () => {
      const questions = watchBrowserQuestions(page);
      try {
        await accountPage.goto();
      } finally {
        questions.stop();
      }
      expect(questions.asked).toEqual([]);
      await accountPage.autofillDeletePassword("a-saved-password");
      await expect(accountPage.deletePasswordInput()).toHaveValue("");
    });

    await test.step("Back to your weddings goes straight to the dashboard", async () => {
      const questions = watchBrowserQuestions(page);
      try {
        await accountPage.backToWeddingsLink().click();
        await expect(page).toHaveURL(/\/dashboard$/);
      } finally {
        questions.stop();
      }
      expect(questions.asked).toEqual([]);
      await expect(accountPage.leaveQuestion()).toHaveCount(0);
    });

    await test.step("The browser's Back leaves the page too", async () => {
      await accountPage.goto();
      await accountPage.autofillDeletePassword("a-saved-password");
      const questions = watchBrowserQuestions(page);
      try {
        await page.goBack();
        await expect(page).toHaveURL(/\/dashboard$/);
      } finally {
        questions.stop();
      }
      expect(questions.asked).toEqual([]);
    });

    // Typing still counts.
    await accountPage.goto();
    await accountPage.typeDeletePassword("typed-on-purpose");
    await expect(accountPage.deletePasswordInput()).toHaveValue("typed-on-purpose");
    await expect(accountPage.deleteAccountButton()).toBeEnabled();
  },
);
