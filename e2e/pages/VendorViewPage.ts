/**
 * TS-114 — page object for a vendor's read-only page (/vendor/<token>), opened from the private
 * link the planner shares. No sign-in, so it's driven from a fresh, signed-out browser context.
 */

import { BasePage } from "./BasePage.js";

export class VendorViewPage extends BasePage {
  async gotoUrl(url: string): Promise<void> {
    await this.page.goto(new URL(url).pathname);
  }

  async gotoToken(token: string): Promise<void> {
    await this.page.goto(`/vendor/${token}`);
  }

  heading() {
    return this.page.getByRole("heading", { level: 1 });
  }

  inactiveMessage() {
    return this.page.getByRole("heading", { name: "This link is no longer active" });
  }

  yourDetails() {
    return this.page.getByRole("region", { name: "Your details" });
  }

  timeline() {
    return this.page.getByRole("region", { name: "Timeline" });
  }

  otherVendors() {
    return this.page.getByRole("region", { name: "Other vendors" });
  }

  /** Everything the page shows, for checking that private details never appear. */
  async allText(): Promise<string> {
    return (await this.page.locator("main").textContent()) ?? "";
  }
}
