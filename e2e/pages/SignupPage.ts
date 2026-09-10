/**
 * Stage 03 — page object for /signup. Selectors centralized here; the app's stable ids
 * (`signup-name`, `signup-email`, `signup-password`) are used directly.
 */

import { expect } from "@playwright/test";
import { BasePage } from "./BasePage.js";

export class SignupPage extends BasePage {
  private nameInput() {
    return this.page.locator("#signup-name");
  }

  private emailInput() {
    return this.page.locator("#signup-email");
  }

  private passwordInput() {
    return this.page.locator("#signup-password");
  }

  private submitButton() {
    return this.page.getByRole("button", { name: /create account/i });
  }

  /** Same disclosed gap as LoginPage.errorMessage() -- no stable selector is exposed by the app. */
  private errorMessage() {
    return this.page.locator("p.text-red-600");
  }

  async goto(): Promise<void> {
    await this.page.goto("/signup");
  }

  async signUp(name: string, email: string, password: string): Promise<void> {
    await this.nameInput().fill(name);
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
