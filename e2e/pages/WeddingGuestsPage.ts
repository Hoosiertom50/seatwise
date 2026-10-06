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
  /** TS-129: the planner's private notes. */
  notes?: string;
}

export class WeddingGuestsPage extends BasePage {
  private guestsTabButton() {
    return this.page.getByRole("tab", { name: "Guests", exact: true });
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

  private notesInput() {
    return this.page.locator("#guest-notes");
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

  /** TS-94: types into the add-guest form's first-name field *without* submitting -- the
   * "half-finished work" a session expiry must not throw away. */
  async typeNewGuestFirstName(value: string): Promise<void> {
    await this.firstNameInput().fill(value);
  }

  async newGuestFirstName(): Promise<string> {
    return this.firstNameInput().inputValue();
  }

  /** Finishes the add-guest form started with `typeNewGuestFirstName` and submits it. */
  async finishAddingGuest(lastName: string): Promise<void> {
    await this.lastNameInput().fill(lastName);
    await this.addGuestButton().click();
  }

  /** Any message the tab shows the user (e.g. its red error banner), matched by its text -- a
   * string matches the whole element text exactly, so the same reason echoed inside the header's
   * save status ("Not saved: <reason>", TS-93) isn't a second match. */
  message(text: string | RegExp) {
    return typeof text === "string" ? this.page.getByText(text, { exact: true }) : this.page.getByText(text);
  }

  /** TS-112: the add-guest form's optional fields sit behind "More details" -- opens it if it's
   * still collapsed (a no-op once open). */
  async openMoreDetails(): Promise<void> {
    const toggle = this.page.getByRole("button", { name: /^\+ More details/ });
    if (await toggle.count()) await toggle.click();
  }

  /** TS-112: whether the optional fields are currently showing. */
  optionalFieldsVisible() {
    return this.partyNameInput();
  }

  /** Business-readable operation: fill the add-guest form and submit it. */
  async addGuest(input: AddGuestInput): Promise<void> {
    await this.firstNameInput().fill(input.firstName);
    await this.lastNameInput().fill(input.lastName);
    if (input.partyName || input.email || input.notes) await this.openMoreDetails();
    if (input.partyName) await this.partyNameInput().fill(input.partyName);
    if (input.email) await this.emailInput().fill(input.email);
    if (input.notes) await this.notesInput().fill(input.notes);
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

  /** TS-92: confirms a preview the server is expected to refuse (e.g. a guest in it changed since
   * the preview) -- waits for the commit response itself, since no success summary will appear. */
  async confirmImportExpectingRefusal(): Promise<void> {
    await Promise.all([
      this.page.waitForResponse((res) => res.url().includes("/guests/import/commit") && res.request().method() === "POST"),
      this.confirmImportButton().click(),
    ]);
  }

  // TS-118: the import form's helpers and guards.
  importExampleToggle() {
    return this.page.getByRole("button", { name: /^(See an example|Hide example)$/ });
  }
  importExampleTable() {
    return this.page.getByRole("table").filter({ has: this.page.getByRole("columnheader", { name: "First name" }) });
  }
  downloadExampleButton() {
    return this.page.getByRole("button", { name: "Download example CSV", exact: true });
  }
  /** Chooses a CSV file without previewing it. */
  async chooseImportFile(csvContent: string, name = "guests.csv"): Promise<void> {
    await this.importFileInput().setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(csvContent, "utf-8") });
  }
  /** TS-190: uploads a file's exact bytes (e.g. one saved in Excel's older Windows encoding) and
   * requests a preview. */
  async importGuestsFileBytesAndPreview(bytes: Buffer, name = "guests.csv"): Promise<void> {
    await this.importFileInput().setInputFiles({ name, mimeType: "text/csv", buffer: bytes });
    await this.previewImportButton().click();
    await this.confirmImportButton().waitFor();
  }
  /** TS-190: chooses a file's exact bytes without previewing it. */
  async chooseImportFileBytes(bytes: Buffer, name = "guests.csv"): Promise<void> {
    await this.importFileInput().setInputFiles({ name, mimeType: "text/csv", buffer: bytes });
  }
  /** TS-190: the preview's summary line ("N new, N updating, N unchanged, ..."). */
  importPreviewSummaryText() {
    return this.page.getByText(/ new, \d+ updating, /);
  }
  /** TS-190: a preview row, by the guest's name in it. */
  importPreviewRow(fullName: string) {
    return this.page.locator("li").filter({ hasText: /^Row \d+/ }).filter({ hasText: fullName });
  }
  /** TS-140: a column-mapping select, by its field label (e.g. "First name *"). */
  importMappingSelect(label: string | RegExp) {
    return this.page.getByLabel(label);
  }
  previewImportButtonLocator() {
    return this.previewImportButton();
  }
  async cancelImport(): Promise<void> {
    await this.page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  importMappingHeading() {
    return this.page.getByText(/ — map columns to guest fields:$/);
  }
  /** TS-180: the preview rows for guests changed in Seatwise since the file was exported. */
  importChangedSinceExportRows() {
    return this.page.locator("li").filter({ hasText: "Changed in Seatwise since this file was exported" });
  }
  /** TS-180: the box that lets those guests be overwritten anyway. */
  overwriteChangedCheckbox() {
    return this.page.getByRole("checkbox", { name: /^Overwrite guests changed since the export/ });
  }
  /** TS-180: the Confirm import button, to read the number of guests it will import. */
  confirmImportButtonLocator() {
    return this.confirmImportButton();
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
  /** TS-129: a guest's row as a View/Comment user sees it -- the name is plain text there, not
   * inputs, so (unlike `guestRow`) it's found by the row's text. */
  readOnlyGuestRow(fullName: string): GuestRow {
    return new GuestRow(this.page.locator("li").filter({ hasText: fullName }));
  }

  guestRow(fullName: string): GuestRow {
    const li = this.page.locator("li").filter({
      has: this.page.locator(`input[aria-label="First name for ${fullName}"]`),
    });
    return new GuestRow(li);
  }

  /** TS-177: the guest list's heading, "Guests (N invitations · N people)". */
  guestListHeading() {
    return this.page.getByRole("heading", { name: /^Guests \(/ });
  }

  /** TS-170: the "Export guest list (CSV)" link. */
  exportCsvLink() {
    return this.page.getByRole("link", { name: "Export guest list (CSV)", exact: true });
  }
}
