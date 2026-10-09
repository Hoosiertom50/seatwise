/**
 * TS-257 (REQ-NON-FUNCTIONAL) — the Account page's Appearance setting: Light, Dark or Match my
 * device. A choice applies at once, survives a reload, reaches other pages and other open tabs,
 * and is kept in this browser only; Match my device follows the device's own setting, as before.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import type { Page } from "@playwright/test";

const LIGHT_BACKGROUND = "rgb(255, 255, 255)";
const DARK_BACKGROUND = "rgb(10, 10, 10)";

function pageBackground(page: Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

defineQualityTest(
  {
    id: "account-management.appearance-light-dark-or-device.choice-applies-and-sticks",
    title: "the Appearance setting switches the app to Light or Dark at once, keeps it after a reload and on other pages and tabs, and Match my device follows the device",
    objective:
      "Confirms that choosing Dark on a light-mode device darkens the page straight away, that the choice is still in force after a reload, on the dashboard and in a second tab, that choosing Light on a dark-mode device lightens it, and that Match my device hands control back to the device.",
    expectedOutcome:
      "With the device in light mode, Dark gives a dark page background (also after a reload, on the dashboard and in a tab already open); with the device in dark mode, Light gives a white background; Match my device then follows the device (dark), and the radio shown matches the saved choice.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:low", "@suite:regression"],
  },
  async ({ account, page, context }) => {
    void account;
    const accountPage = new AccountPage(page);

    await test.step("Device in light mode: the page starts light and Match my device is chosen", async () => {
      await page.emulateMedia({ colorScheme: "light" });
      await accountPage.goto();
      await expect(accountPage.appearanceChoice("Match my device")).toBeChecked();
      expect(await pageBackground(page)).toBe(LIGHT_BACKGROUND);
    });

    const otherTab = await context.newPage();
    await test.step("A second tab is open on the dashboard", async () => {
      await otherTab.emulateMedia({ colorScheme: "light" });
      await new DashboardPage(otherTab).goto();
      expect(await pageBackground(otherTab)).toBe(LIGHT_BACKGROUND);
    });

    await test.step("Choosing Dark darkens this page at once, and the other tab follows", async () => {
      await accountPage.appearanceChoice("Dark").check();
      await expect.poll(() => pageBackground(page)).toBe(DARK_BACKGROUND);
      await expect.poll(() => pageBackground(otherTab)).toBe(DARK_BACKGROUND);
    });

    await test.step("Dark is kept after a reload and on the dashboard", async () => {
      await page.reload();
      await expect(accountPage.appearanceChoice("Dark")).toBeChecked();
      expect(await pageBackground(page)).toBe(DARK_BACKGROUND);
      await new DashboardPage(page).goto();
      expect(await pageBackground(page)).toBe(DARK_BACKGROUND);
    });

    await test.step("Device in dark mode: choosing Light lightens the page", async () => {
      await page.emulateMedia({ colorScheme: "dark" });
      await accountPage.goto();
      await accountPage.appearanceChoice("Light").check();
      await expect.poll(() => pageBackground(page)).toBe(LIGHT_BACKGROUND);
      await page.reload();
      await expect(accountPage.appearanceChoice("Light")).toBeChecked();
      expect(await pageBackground(page)).toBe(LIGHT_BACKGROUND);
    });

    await test.step("Match my device follows the device again (dark)", async () => {
      await accountPage.appearanceChoice("Match my device").check();
      await expect.poll(() => pageBackground(page)).toBe(DARK_BACKGROUND);
      await page.reload();
      await expect(accountPage.appearanceChoice("Match my device")).toBeChecked();
      expect(await pageBackground(page)).toBe(DARK_BACKGROUND);
    });

    await otherTab.close();
  },
);

defineQualityTest(
  {
    id: "account-management.appearance-light-dark-or-device.blocked-storage-still-applies",
    title: "when the browser won't save the Appearance choice, it still applies to the page and the chosen button stays picked",
    objective:
      "Confirms that with saving to browser storage refused (blocked site data), choosing Dark still darkens the page and Dark stays the picked choice instead of jumping back to Match my device.",
    expectedOutcome: "With storage writes refused, clicking Dark gives a dark background and the Dark radio is checked; Match my device is not.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:low", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const accountPage = new AccountPage(page);

    await test.step("Arrange: the browser refuses to save anything to storage, and the device is light", async () => {
      await page.addInitScript(() => {
        const refuse = () => {
          throw new DOMException("blocked", "SecurityError");
        };
        Storage.prototype.setItem = refuse;
        Storage.prototype.removeItem = refuse;
      });
      await page.emulateMedia({ colorScheme: "light" });
      await accountPage.goto();
    });

    await test.step("Choosing Dark darkens the page and Dark stays picked", async () => {
      await accountPage.appearanceChoice("Dark").check();
      await expect.poll(() => pageBackground(page)).toBe(DARK_BACKGROUND);
      await expect(accountPage.appearanceChoice("Dark")).toBeChecked();
      await expect(accountPage.appearanceChoice("Match my device")).not.toBeChecked();
    });
  },
);
