/**
 * Stage 03 — reusable component object for one guest row on the Guests tab (spec Section 7.2:
 * "Shared widgets shall use component objects rather than duplicated selectors"). Receives its
 * root `Locator` through the constructor (never a `Page` it stashes globally), so it holds no
 * mutable browser state of its own -- it is a thin, disposable view over whatever `Locator` it
 * was built from.
 *
 * Every field selector here is scoped *within* `root` and keyed off the app's own
 * `aria-label="<Field> for <First> <Last>"` convention (see GuestsTab.tsx) -- a real,
 * semantically-meaningful attribute the app already exposes, not an invented test hook.
 */

import { expect, type Locator } from "@playwright/test";

export class GuestRow {
  constructor(private readonly root: Locator) {}

  /** The row's own locator, for existence/visibility assertions from the caller. */
  locator(): Locator {
    return this.root;
  }

  private fieldByAriaLabelPrefix(tag: "select" | "input", prefix: string): Locator {
    // Playwright locators don't support a native "starts-with" attribute selector directly, so
    // this uses a CSS attribute selector (`^=`) rather than string-matching the DOM in JS.
    return this.root.locator(`${tag}[aria-label^="${prefix}"]`);
  }

  private rsvpStatusSelect() {
    return this.fieldByAriaLabelPrefix("select", "RSVP status for ");
  }

  private sideSelect() {
    return this.fieldByAriaLabelPrefix("select", "Side for ");
  }

  private firstNameInput() {
    return this.fieldByAriaLabelPrefix("input", "First name for ");
  }

  private lastNameInput() {
    return this.fieldByAriaLabelPrefix("input", "Last name for ");
  }

  private removeButton() {
    return this.root.getByRole("button", { name: "Remove" });
  }

  /** Reads the guest's displayed name. Deliberately reads the editable-name `<input>`'s *value*
   * (via `.inputValue()`), not the row's text content -- an input's value is never part of an
   * element's rendered text, so a caller who reaches for `toContainText`/`hasText` against this
   * row for the name will silently match nothing when the viewer can edit the guest (see
   * WeddingGuestsPage.guestRow's own doc comment for how this bit the framework's own reference
   * test during Stage 03). */
  async firstName(): Promise<string> {
    return this.firstNameInput().inputValue();
  }

  async lastName(): Promise<string> {
    return this.lastNameInput().inputValue();
  }

  async rsvpStatus(): Promise<string> {
    return this.rsvpStatusSelect().inputValue();
  }

  async setRsvpStatus(status: "PENDING" | "CONFIRMED" | "DECLINED"): Promise<void> {
    await this.rsvpStatusSelect().selectOption(status);
  }

  async setSide(side: "BRIDE" | "GROOM" | "BOTH"): Promise<void> {
    await this.sideSelect().selectOption(side);
  }

  async remove(): Promise<void> {
    await this.removeButton().click();
  }

  async expectVisible(): Promise<void> {
    await expect(this.root).toBeVisible();
  }
}
