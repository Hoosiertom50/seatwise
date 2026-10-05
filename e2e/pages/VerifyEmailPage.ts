/**
 * TS-164 — page object for the "Confirm your email" page (/verify-email/<token>), opened from the
 * link emailed at sign-up, and for the reminder banner shown until the address is confirmed.
 */

import { BasePage } from "./BasePage.js";

export class VerifyEmailPage extends BasePage {
  async goto(token: string): Promise<void> {
    await this.page.goto(`/verify-email/${token}`);
  }

  confirmButton() {
    return this.page.getByRole("button", { name: "Confirm my email", exact: true });
  }

  confirmedMessage() {
    return this.page.getByRole("status").filter({ hasText: "your email address is confirmed" });
  }

  errorMessage() {
    return this.page.getByRole("main").getByRole("alert");
  }

  /** The "Please confirm your email address" banner on the dashboard and wedding pages. */
  reminderBanner() {
    return this.page.getByRole("region", { name: "Confirm your email" });
  }
}
