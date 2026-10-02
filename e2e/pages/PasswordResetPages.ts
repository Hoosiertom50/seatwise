/**
 * TS-142 — page object for the "Forgot password?" flow: the sign-in page's link, the request page
 * (/forgot-password) and the page the emailed link opens (/reset-password/<token>).
 */

import { BasePage } from "./BasePage.js";

export class PasswordResetPages extends BasePage {
  async gotoLogin(): Promise<void> {
    await this.page.goto("/login");
  }

  forgotPasswordLink() {
    return this.page.getByRole("link", { name: "Forgot password?", exact: true });
  }

  async gotoForgotPassword(): Promise<void> {
    await this.page.goto("/forgot-password");
  }

  /** Follows the sign-in page's link and waits for the request form. */
  async openForgotPasswordFromLogin(): Promise<void> {
    await this.forgotPasswordLink().click();
    await this.page.waitForURL(/\/forgot-password$/);
    await this.page.getByRole("button", { name: "Send reset link", exact: true }).waitFor();
  }

  async waitForDashboard(): Promise<void> {
    await this.page.waitForURL(/\/dashboard$/);
  }

  async requestReset(email: string): Promise<void> {
    await this.page.getByLabel("Email", { exact: true }).fill(email);
    await this.page.getByRole("button", { name: "Send reset link", exact: true }).click();
  }

  confirmation() {
    return this.page.getByRole("status");
  }

  /** TS-142: the "no account for that email" message, with its Sign up link. */
  noAccountMessage() {
    return this.page.getByRole("alert").filter({ hasText: "There's no Seatwise account for that email." });
  }

  async gotoResetLink(token: string): Promise<void> {
    await this.page.goto(`/reset-password/${token}`);
  }

  async chooseNewPassword(password: string, confirm = password): Promise<void> {
    await this.page.getByLabel("New password", { exact: true }).fill(password);
    await this.page.getByLabel("Type it again", { exact: true }).fill(confirm);
    await this.page.getByRole("button", { name: "Save new password", exact: true }).click();
  }

  noLongerValid() {
    return this.page.getByText("This reset link is no longer valid — request a new one.", { exact: true });
  }

  message(text: string | RegExp) {
    return typeof text === "string" ? this.page.getByText(text, { exact: true }) : this.page.getByText(text);
  }
}
