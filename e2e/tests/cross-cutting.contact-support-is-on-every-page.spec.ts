/**
 * TS-100 (REQ-NON-FUNCTIONAL) — people can always reach a real person. Every page carries a
 * "Contact support" footer that emails the support address with the reply-time promise next to it,
 * signed in or not, and the Account page has its own "Get help" section (Tom's decisions,
 * 2026-10-02).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { SupportFooter } from "../components/SupportFooter.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { LoginPage } from "../pages/LoginPage.js";

const SUPPORT_EMAIL = "seatwise.notifications+support@gmail.com";
const MAILTO = `mailto:${SUPPORT_EMAIL}?subject=Seatwise%20support`;
const PROMISE = "A real person replies within 1 business day.";

defineQualityTest(
  {
    id: "cross-cutting.contact-support-is-on-every-page.footer-and-account-help",
    title: "every page offers a Contact support email link with the reply-time promise, signed in or not, and the Account page has a Get help section",
    objective:
      "Confirms that the sign-in page (signed out), the dashboard and the Account page each show a footer with a Contact support link to the support address and the 1-business-day promise, and that the Account page's Get help section links to the same address.",
    expectedOutcome:
      "Each footer's Contact support link points at mailto:seatwise.notifications+support@gmail.com?subject=Seatwise%20support and the footer shows the address and 'A real person replies within 1 business day.' The Account page's Email support link points at the same mailto.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page, browser }) => {
    void account;

    await test.step("Signed out: the sign-in page has the footer", async () => {
      const visitor = await browser.newContext();
      try {
        const visitorPage = await visitor.newPage();
        await new LoginPage(visitorPage).goto();
        const footer = new SupportFooter(visitorPage);
        await expect(footer.contactLink()).toHaveAttribute("href", MAILTO);
        await expect(footer.root()).toContainText(SUPPORT_EMAIL);
        await expect(footer.root()).toContainText(PROMISE);
      } finally {
        await visitor.close();
      }
    });

    await test.step("Signed in: the dashboard has the footer", async () => {
      await new DashboardPage(page).goto();
      const footer = new SupportFooter(page);
      await expect(footer.contactLink()).toHaveAttribute("href", MAILTO);
      await expect(footer.root()).toContainText(PROMISE);
    });

    await test.step("The Account page has the footer and its own Get help section", async () => {
      const accountPage = new AccountPage(page);
      await accountPage.goto();
      await expect(new SupportFooter(page).contactLink()).toHaveAttribute("href", MAILTO);
      await expect(accountPage.emailSupportLink()).toHaveAttribute("href", MAILTO);
      await expect(accountPage.getHelpSection()).toContainText(PROMISE);
    });
  },
);
