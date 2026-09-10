/**
 * Stage 03 — page object for /login. Selectors are centralized here (spec Section 7.2); the app's
 * own stable `id` attributes (`login-email`, `login-password`) are used directly rather than
 * inventing brittle structural locators.
 */

import { expect } from "@playwright/test";
import { BasePage } from "./BasePage.js";

export class LoginPage extends BasePage {
  private emailInput() {
    return this.page.locator("#login-email");
  }

  private passwordInput() {
    return this.page.locator("#login-password");
  }

  private submitButton() {
    return this.page.getByRole("button", { name: /log in/i });
  }

  /**
   * No stable id/data-testid is exposed for the inline error message (the app renders a plain
   * `<p className="text-red-600 ...">`), so this falls back to a CSS class selector -- fragile,
   * and disclosed as a Stage 03 quality-rubric gap rather than silently relied on as if it were
   * robust. See stage-03-audit.md.
   */
  private errorMessage() {
    return this.page.locator("p.text-red-600");
  }

  async goto(): Promise<void> {
    await this.page.goto("/login");
  }

  /** Business-readable operation: log in and wait for the resulting navigation to settle. */
  async login(email: string, password: string): Promise<void> {
    await this.emailInput().fill(email);
    await this.passwordInput().fill(password);
    await this.submitButton().click();
  }

  async expectError(messageSubstring?: string): Promise<void> {
    const error = this.errorMessage();
    await error.waitFor({ state: "visible" });
    if (messageSubstring) {
      await expect(error).toContainText(messageSubstring);
    }
  }
}
