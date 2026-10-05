/**
 * TS-116 (REQ-COLLABORATION-NOTIFICATIONS) — page object for the public invite page
 * (apps/web/src/app/invites/[token]/page.tsx). It shows the wedding's name, role and level only
 * for a PENDING invite that matches whoever is signed in; every other state shows its status line
 * and nothing about the wedding.
 */

import { BasePage } from "./BasePage.js";

export type InvitePageState = "NOT_FOUND" | "REVOKED" | "EXPIRED" | "ACCEPTED" | "MISMATCHED_ACCOUNT";

const STATE_TEXT: Record<InvitePageState, string> = {
  NOT_FOUND: "This invite link doesn't exist.",
  REVOKED: "This invite has been revoked by the wedding's owner.",
  EXPIRED: "This invite has expired.",
  ACCEPTED: "This invite has already been accepted.",
  MISMATCHED_ACCOUNT: "This invite was sent to a different email address",
};

export class InviteAcceptPage extends BasePage {
  async goto(token: string): Promise<void> {
    await this.page.goto(`/invites/${token}`);
    await this.page.getByRole("heading", { name: "Wedding invite", exact: true }).waitFor();
  }

  stateMessage(state: InvitePageState) {
    return this.page.getByText(STATE_TEXT[state]);
  }

  /** The pending invite's summary line: "You've been invited to join <wedding> ... access." */
  invitationSummary() {
    return this.page.getByText(/^You've been invited to join/);
  }

  acceptButton() {
    return this.page.getByRole("button", { name: "Accept invite", exact: true });
  }

  async accept(): Promise<void> {
    await this.acceptButton().click();
  }

  /** The signed-out prompt to sign in or sign up with the invited address. */
  signInPrompt() {
    return this.page.getByText(/^Sign in or create an account with/);
  }

  createAccountLink() {
    return this.page.getByRole("link", { name: "Or create an account", exact: true });
  }

  logInLink() {
    return this.page.getByRole("link", { name: "Log in", exact: true });
  }

  /** TS-164: the message shown when accepting is refused (e.g. the account hasn't confirmed its email). */
  acceptError() {
    return this.page.locator("main p.text-red-600, main p.text-red-400");
  }
}
