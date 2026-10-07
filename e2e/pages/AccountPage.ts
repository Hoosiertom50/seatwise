/**
 * TS-105 — page object for the signed-in planner's Account page (/account): deleting the account.
 */

import { BasePage } from "./BasePage.js";
import { ConfirmDelete } from "../components/ConfirmDelete.js";

export class AccountPage extends BasePage {
  async goto(): Promise<void> {
    await this.page.goto("/account");
    await this.page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
  }

  /** Enters the password, clicks Delete my account and answers "Yes" to the TS-136 question. */
  async deleteAccount(password: string): Promise<void> {
    await this.page.getByLabel("Your password", { exact: true }).fill(password);
    await this.page.getByRole("button", { name: "Delete my account", exact: true }).click();
    await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === "/api/v1/auth/me"),
      new ConfirmDelete(this.page).confirm(),
    ]);
  }

  /** TS-100: the "Get help" section and its Email support link. */
  getHelpSection() {
    return this.page.getByRole("region", { name: "Get help", exact: true });
  }
  emailSupportLink() {
    return this.getHelpSection().getByRole("link", { name: "Email support", exact: true });
  }

  message(text: string | RegExp) {
    return typeof text === "string" ? this.page.getByText(text, { exact: true }) : this.page.getByText(text);
  }

  /** A wedding still owned by this account, as listed after a refused deletion. */
  ownedWeddingLink(name: string) {
    return this.page.getByRole("link", { name, exact: true });
  }

  deletedHeading() {
    return this.page.getByRole("heading", { name: "Your account has been deleted" });
  }

  /** TS-204: the "Signed in elsewhere" section and its Log out on all devices button. */
  logOutEverywhereButton() {
    return this.page.getByRole("region", { name: "Signed in elsewhere", exact: true }).getByRole("button", { name: "Log out on all devices", exact: true });
  }

  /** TS-223: the message shown in the "Signed in elsewhere" section when Log out on all devices can't work. */
  logOutEverywhereMessage() {
    return this.page.getByRole("region", { name: "Signed in elsewhere", exact: true }).getByRole("alert");
  }

  /** TS-223: the section's "Sign in" link, shown with that message. */
  logOutEverywhereSignInLink() {
    return this.page.getByRole("region", { name: "Signed in elsewhere", exact: true }).getByRole("link", { name: "Sign in", exact: true });
  }

  /** TS-223: presses Log out on all devices and waits for the server's answer; returns its status. */
  async pressLogOutEverywhere(): Promise<number> {
    const [res] = await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/auth/logout"),
      this.logOutEverywhereButton().click(),
    ]);
    return res.status();
  }

  /** TS-204: signs out every device, landing on the sign-in page. */
  async logOutEverywhere(): Promise<void> {
    await this.logOutEverywhereButton().click();
    await this.page.waitForURL(/\/login/);
  }
}
