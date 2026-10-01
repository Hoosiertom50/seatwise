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
import { ConfirmDelete } from "./ConfirmDelete.js";

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

  /** TS-129: the planner's private notes -- a textarea for Owner/Edit users. */
  private notesInput() {
    return this.root.locator('textarea[aria-label^="Notes for "]');
  }

  // TS-136: the trigger is named "Remove <who/what>", and opens the "Are you sure?" step.
  private removeButton() {
    return this.root.getByRole("button", { name: /^Remove / });
  }

  /** TS-136: clicks Remove without answering, leaving the "Are you sure?" question open. */
  async startRemove(): Promise<void> {
    await this.removeButton().click();
  }

  /** TS-136: the "Are you sure?" step for this row. */
  removeConfirmation(): ConfirmDelete {
    return new ConfirmDelete(this.root);
  }

  /** TS-38: the Lock/Unlock toggle -- its accessible name flips with the guest's own `isLocked`
   * state (see GuestsTab.tsx), so `{ exact: true }` keeps "Lock" from also matching "Unlock". */
  private lockButton() {
    return this.root.getByRole("button", { name: "Lock", exact: true }).or(
      this.root.getByRole("button", { name: "Unlock", exact: true }),
    );
  }

  /** Clicks the Lock/Unlock toggle, whichever state it's currently in, and waits for the button
   * to settle on its new label before returning -- without this, a caller that reads `isLocked()`
   * immediately after can race the click against the lock-status mutation + re-render (TS-66:
   * this raced intermittently in Firefox). Mirrors the same "wait for the button's resting state"
   * pattern DayOfTabPage.addWalkIn()/swap() already use for their own submit buttons. */
  // TS-128: the label flips optimistically, before the server has saved anything -- so waiting for
  // the label alone let a caller race ahead (e.g. regenerate the plan) while the lock was still in
  // flight, and an occasional WebKit failure here was never explained. It now also waits for the
  // PATCH itself and fails with its status if the server refused it.
  async toggleLock(): Promise<void> {
    const button = this.lockButton();
    const wasLocked = (await button.textContent())?.trim() === "Unlock";
    const page = this.root.page();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/v1\/weddings\/[^/]+\/guests\/[^/]+$/.test(new URL(r.url()).pathname)),
      button.click(),
    ]);
    expect(res.ok(), `saving the lock returned ${res.status()}`).toBe(true);
    const newLabel = wasLocked ? "Lock" : "Unlock";
    await this.root.getByRole("button", { name: newLabel, exact: true }).waitFor();
  }

  async isLocked(): Promise<boolean> {
    return (await this.lockButton().textContent())?.trim() === "Unlock";
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

  /** TS-108: the inline name edit saves on blur -- replace the field's text, then Tab away. */
  async editFirstName(value: string): Promise<void> {
    await this.firstNameInput().fill(value);
    await this.firstNameInput().press("Tab");
  }

  /** TS-129: the notes as the editable textarea currently shows them. */
  async notes(): Promise<string> {
    return this.notesInput().inputValue();
  }

  /** TS-129: notes save on blur, like the name -- replace the text, then Tab away. */
  async editNotes(value: string): Promise<void> {
    await this.notesInput().fill(value);
    await this.notesInput().press("Tab");
  }

  /** TS-129: whether this row offers the notes for editing (View/Comment users get plain text). */
  notesEditor(): Locator {
    return this.notesInput();
  }

  /** TS-129: the read-only "Notes: …" line a View/Comment user sees. */
  readOnlyNotes(): Locator {
    return this.root.locator("p").filter({ hasText: /^Notes:/ });
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

  /** TS-117: "New link" -- issues a fresh RSVP token, invalidating the old one. */
  async requestNewRsvpLink(): Promise<void> {
    await this.root.getByRole("button", { name: "New link", exact: true }).click();
  }

  /** TS-117: the line the row shows after an RSVP-link action: "Link copied…", "Emailed to …", or
   * the bare link when the clipboard isn't available. */
  rsvpLinkResult(): Locator {
    return this.root.getByText(/Link copied|Emailed to|\/rsvp\//);
  }

  /** Removes the guest, answering "Yes" to the TS-136 question. */
  async remove(): Promise<void> {
    await this.removeButton().click();
    await this.removeConfirmation().confirm();
  }

  async expectVisible(): Promise<void> {
    await expect(this.root).toBeVisible();
  }
}
