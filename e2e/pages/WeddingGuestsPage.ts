/**
 * Stage 03 — page object for the wedding-detail page's Guests tab (spec Section 7.2). Exposes
 * business-readable operations (`addGuest`, `guestRow`) rather than raw selector sequences; the
 * app's stable `id`s on the add-guest form (`guest-first-name`, etc.) are used directly.
 */

import { BasePage } from "./BasePage.js";
import { GuestRow } from "../components/GuestRow.js";

export interface AddGuestInput {
  firstName: string;
  lastName: string;
  partyName?: string;
  email?: string;
}

export class WeddingGuestsPage extends BasePage {
  private guestsTabButton() {
    return this.page.getByRole("button", { name: "Guests", exact: true });
  }

  private firstNameInput() {
    return this.page.locator("#guest-first-name");
  }

  private lastNameInput() {
    return this.page.locator("#guest-last-name");
  }

  private partyNameInput() {
    return this.page.locator("#guest-party-name");
  }

  private emailInput() {
    return this.page.locator("#guest-email");
  }

  private addGuestButton() {
    return this.page.getByRole("button", { name: /add guest/i });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
  }

  async openGuestsTab(): Promise<void> {
    await this.guestsTabButton().click();
  }

  /** Business-readable operation: fill the add-guest form and submit it. */
  async addGuest(input: AddGuestInput): Promise<void> {
    await this.firstNameInput().fill(input.firstName);
    await this.lastNameInput().fill(input.lastName);
    if (input.partyName) await this.partyNameInput().fill(input.partyName);
    if (input.email) await this.emailInput().fill(input.email);
    await this.addGuestButton().click();
  }

  /** Returns a GuestRow component object scoped to the row matching this full name. Does not
   * assert the row exists -- callers await `.expectVisible()` (or Playwright's own auto-waiting
   * assertions) to confirm it appeared, keeping this method a pure locator-builder.
   *
   * Filters on the row's `<li>` *containing* a first-name input carrying this guest's
   * `aria-label="First name for <fullName>"` -- not `{ hasText: fullName }`. A row a planner can
   * edit (`canEdit`) renders the name as `<input>` elements with `defaultValue`, and an input's
   * value is never part of an element's rendered text content, so a `hasText` filter silently
   * matches nothing for exactly the common case. This was caught live by this stage's own
   * reference test failing against the real app — see stage-03-audit.md. */
  guestRow(fullName: string): GuestRow {
    const li = this.page.locator("li").filter({
      has: this.page.locator(`input[aria-label="First name for ${fullName}"]`),
    });
    return new GuestRow(li);
  }
}
