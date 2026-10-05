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
}
