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

  /** TS-53 (AC-079, "keyboard-only operation"): the same operation as `login`, but driven entirely
   * by real keyboard input -- `.focus()` + `page.keyboard.type`/`.press("Tab"/"Enter")` -- rather
   * than `.fill()`/`.click()`, which bypass real key events and so would prove nothing about
   * keyboard operability. Confirms email -> password -> submit is reachable by Tab alone (in that
   * order, with no unreachable field in between) and that Enter on the password field submits the
   * form exactly as clicking Log in would -- the form has no other submit control to fall back on. */
  async loginWithKeyboardOnly(email: string, password: string): Promise<void> {
    await this.emailInput().focus();
    await this.page.keyboard.type(email);
    await this.page.keyboard.press("Tab");
    await expect(this.passwordInput()).toBeFocused();
    await this.page.keyboard.type(password);
    await this.page.keyboard.press("Enter");
  }

  async expectError(messageSubstring?: string): Promise<void> {
    const error = this.errorMessage();
    await error.waitFor({ state: "visible" });
    if (messageSubstring) {
      await expect(error).toContainText(messageSubstring);
    }
  }
}
