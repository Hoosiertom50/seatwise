/**
 * TS-264 — component object for the shared header on every signed-in page
 * (apps/web/src/components/SignedInHeader.tsx): the notifications bell, the Account link and Log out
 * at the top right of the dashboard, every wedding tab and the Account page.
 */

import type { Locator, Page } from "@playwright/test";

export class SignedInHeader {
  constructor(private readonly page: Page) {}

  /** The group holding the three controls. */
  controls(): Locator {
    return this.page.getByRole("navigation", { name: "Your account", exact: true });
  }

  bell(): Locator {
    return this.controls().getByRole("button", { name: /^Notifications( \(\d+ unread\))?$/ });
  }

  accountLink(): Locator {
    return this.controls().getByRole("link", { name: "Account", exact: true });
  }

  /** Exact, so it never matches the Account page's own "Log out on all devices". */
  logOutButton(): Locator {
    return this.controls().getByRole("button", { name: "Log out", exact: true });
  }

  /** Presses Log out and waits for the sign-in page. */
  async logOut(): Promise<void> {
    await Promise.all([this.page.waitForURL(/\/login/), this.logOutButton().click()]);
  }

  /** Presses Log out without waiting for anywhere (unsaved input asks first). */
  async pressLogOut(): Promise<void> {
    await this.logOutButton().click();
  }

  /** How many pixels the page is wider than the window (0 when nothing runs off the screen). */
  async horizontalOverflow(): Promise<number> {
    return this.page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  }
}
