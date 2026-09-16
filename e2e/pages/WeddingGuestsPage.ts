/**
 * Stage 03 — page object for the wedding-detail page's Guests tab (spec Section 7.2). Exposes
 * business-readable operations (`addGuest`, `guestRow`) rather than raw selector sequences; the
 * app's stable `id`s on the add-guest form (`guest-first-name`, etc.) are used directly.
 */

import { expect } from "@playwright/test";
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
    // TS-62 SPIKE (DO NOT MERGE): see BasePage.waitForSettled.
    await this.waitForSettled();
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

  /** TS-53 (AC-079, "keyboard-only operation"): fills and submits the add-guest form entirely via
   * real keyboard input -- `.focus()` + `page.keyboard.type`/`.press("Tab"/"Enter")` on the
   * first-name field, then Tab-ing to last name and pressing Enter there -- rather than
   * `.fill()`/`.click()`. Confirms first name -> last name is reachable by Tab alone and that
   * Enter on the last-name field submits the form (the add-guest form has no other submit control
   * a keyboard-only user could fall back on). Does not exercise the optional party-name/email
   * fields -- those are covered by `addGuest`'s own full-field coverage, not this keyboard-specific
   * check, which is only about reachability and submit-by-Enter, not field coverage. */
  async addGuestWithKeyboardOnly(firstName: string, lastName: string): Promise<void> {
    await this.firstNameInput().focus();
    await this.page.keyboard.type(firstName);
    await this.page.keyboard.press("Tab");
    await expect(this.lastNameInput()).toBeFocused();
    await this.page.keyboard.type(lastName);
    await this.page.keyboard.press("Enter");
  }

  // TS-55 (REQ-INTEGRATION-E2E-SCENARIOS): the CSV bulk-import flow (FR-2.4) -- no test anywhere
  // in this suite drives it through the real UI before now (the existing bulk-import tests,
  // guest-list.bulk-import-*.spec.ts, call the preview/commit API endpoints directly). The file
  // input's accessible name comes from the `aria-label` this engagement's own TS-53 accessibility
  // fix added (it had none before); the column-mapping selects are never touched here at all --
  // GuestsTab.tsx's own best-effort auto-mapping (`onFileSelected`'s `guess` logic) matches a CSV
  // header against a field's internal key with punctuation/case stripped, so a header spelled
  // exactly like the field key (e.g. "firstName") auto-maps with zero manual selection needed.
  private importFileInput() {
    return this.page.getByLabel("Upload a CSV file of guests to import", { exact: true });
  }
  private previewImportButton() {
    return this.page.getByRole("button", { name: /^preview import$|^checking\.\.\.$/i });
  }
  private confirmImportButton() {
    return this.page.getByRole("button", { name: /^confirm import/i });
  }
  importCompleteSummaryText() {
    return this.page.getByText(/^Import complete:/);
  }
  importPreviewErrorCountText() {
    return this.page.getByText(/with errors \(of/);
  }

  /** Uploads a CSV (its headers must be spelled exactly like the GuestImportField keys they're
   * meant for -- see this method's own doc comment above -- so the app's auto-mapping needs no
   * help) and requests a preview, leaving the preview's own rows on screen for the caller to
   * assert against before deciding whether to `confirmImport()`. */
  async importGuestsFromCsvAndPreview(csvContent: string): Promise<void> {
    await this.importFileInput().setInputFiles({
      name: "guests.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent, "utf-8"),
    });
    await this.previewImportButton().click();
    await this.confirmImportButton().waitFor();
  }

  /** Confirms a preview already on screen (see `importGuestsFromCsvAndPreview`) and waits for the
   * "Import complete: ..." summary that only renders once the commit has actually resolved. */
  async confirmImport(): Promise<void> {
    await this.confirmImportButton().click();
    await expect(this.importCompleteSummaryText()).toBeVisible();
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
