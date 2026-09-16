/**
 * TS-52 (REQ-BUDGET-VENDOR-TRACKING) — page object for the wedding-detail page's Budget tab
 * (apps/web/src/app/weddings/[weddingId]/components/BudgetTab.tsx): a per-wedding vendor list plus
 * an overall budget figure and a running total/remaining computed against it. Entirely independent
 * of guests/tables/rules/seating plans, same as Timeline.
 *
 * Real finding, confirmed directly in BudgetTab.tsx's own mount effect (the same shape already
 * documented and fixed in TimelineTabPage.goto -- see that page object's own comment for the full
 * mechanism): its `useEffect` fires two GETs (vendors + budget, via `Promise.all`) on every mount,
 * and React Strict Mode under `next dev` double-invokes that effect, so up to *four* overlapping
 * GETs can be in flight right after this tab opens. A mutating action performed before the slowest
 * of them settles risks a stale `setVendors(...)`/`setSummary(...)` silently clobbering it. `goto`
 * here waits for the network to go idle before returning, same fix, applied proactively rather than
 * rediscovered.
 *
 * Real finding, confirmed directly in the JSX: a vendor row's name and its category badge render
 * as adjacent children of the same `<p>` with no separator (`{v.name}<span>{categoryLabel}</span>`),
 * so their rendered text concatenates with nothing between them (e.g. "Kids CornerFlorist") -- the
 * same class of issue as GuestRsvpPage's notesInput finding. An *exact* text match on a bare vendor
 * name therefore never matches once its row has rendered (the badge is always present). Row lookups
 * here use a substring `hasText` filter instead, mirroring DashboardPage's `weddingLink`/
 * `templateRow` (chosen there for a different reason -- no stable id -- but the same fix shape).
 */

import { expect } from "@playwright/test";
import { BasePage } from "./BasePage.js";

export interface AddVendorInput {
  name: string;
  category?: string;
  categoryOther?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  cost?: string;
  contractNotes?: string;
}

export class BudgetTabPage extends BasePage {
  private budgetTabButton() {
    return this.page.getByRole("button", { name: "Budget", exact: true });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
    // TS-62 SPIKE (DO NOT MERGE): see BasePage.waitForSettled.
    await this.waitForSettled();
    await this.budgetTabButton().click();
    await this.page.waitForLoadState("networkidle");
  }

  viewOnlyNotice() {
    return this.page.getByText(
      "You have view-only access to this wedding's budget — adding, editing, and removing vendors is turned off.",
      { exact: true },
    );
  }

  errorText() {
    return this.page.locator("p.text-red-600, p.text-red-400");
  }

  // --- Overall budget section ---

  private budgetInput() {
    return this.page.locator("#budget-total");
  }
  private saveBudgetButton() {
    return this.page.getByRole("button", { name: /^save budget$|^saving\.\.\.$/i });
  }

  /** Reads one of the three overview stat values (Budget, Recorded so far, Remaining) as plain
   * text (never parsed to a number here -- "Not set" and "—" are valid, non-numeric values for
   * Budget/Remaining respectively) -- same sibling-<p> pattern as TablesTabPage.statValue, since
   * this overview strip is built the same way. */
  private statText(label: string) {
    return this.page.getByText(label, { exact: true }).locator("xpath=following-sibling::p");
  }

  budgetText() {
    return this.statText("Budget");
  }
  recordedSoFarText() {
    return this.statText("Recorded so far");
  }
  remainingText() {
    return this.statText("Remaining");
  }

  /** The "Recorded vendor costs are over budget by {amount}." warning line -- only rendered once
   * remainingCents is actually negative. */
  overBudgetWarning() {
    return this.page.getByText(/^Recorded vendor costs are over budget by/);
  }

  /** Fills the budget field and submits, waiting for the PATCH to resolve (onSaveBudget updates
   * React state directly from the response body -- no separate refetch). Passing `""` clears the
   * field, which BudgetTab's own `dollarsStringToCents` maps to `null` ("no budget set"), not 0. */
  async saveBudget(dollars: string): Promise<void> {
    await this.budgetInput().fill(dollars);
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "PATCH" && /\/budget$/.test(new URL(res.url()).pathname),
      ),
      this.saveBudgetButton().click(),
    ]);
  }

  // --- Add-a-vendor section ---

  private vendorNameInput() {
    return this.page.locator("#vendor-name");
  }
  private categorySelect() {
    return this.page.locator("#vendor-category");
  }
  private categoryOtherInput() {
    return this.page.getByLabel("Category label", { exact: true });
  }
  private contactNameInput() {
    return this.page.locator("#vendor-contact-name");
  }
  private costInput() {
    return this.page.locator("#vendor-cost");
  }
  private contactEmailInput() {
    return this.page.locator("#vendor-contact-email");
  }
  private contactPhoneInput() {
    return this.page.locator("#vendor-contact-phone");
  }
  private notesInput() {
    return this.page.locator("#vendor-notes");
  }
  private addVendorButton() {
    return this.page.getByRole("button", { name: /^add vendor$|^adding\.\.\.$/i });
  }

  /** Fills and submits the "Add a vendor" form, waiting for the POST to resolve and for the form's
   * own fields to clear (onAdd's state reset, confirming its `.then()` has actually run) before
   * returning -- same established pattern as TimelineTabPage.addEntry. `category` is the visible
   * option label text (e.g. "Florist", "Music / Entertainment"), not the underlying enum value. */
  async addVendor(input: AddVendorInput): Promise<void> {
    await this.vendorNameInput().fill(input.name);
    if (input.category) {
      await this.categorySelect().selectOption({ label: input.category });
    }
    if (input.categoryOther !== undefined) {
      await this.categoryOtherInput().fill(input.categoryOther);
    }
    if (input.contactName !== undefined) {
      await this.contactNameInput().fill(input.contactName);
    }
    if (input.cost !== undefined) {
      await this.costInput().fill(input.cost);
    }
    if (input.contactEmail !== undefined) {
      await this.contactEmailInput().fill(input.contactEmail);
    }
    if (input.contactPhone !== undefined) {
      await this.contactPhoneInput().fill(input.contactPhone);
    }
    if (input.contractNotes !== undefined) {
      await this.notesInput().fill(input.contractNotes);
    }
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "POST" && /\/vendors$/.test(new URL(res.url()).pathname),
      ),
      this.addVendorButton().click(),
    ]);
    await this.page.waitForFunction(
      () => (document.querySelector<HTMLInputElement>("#vendor-name")?.value ?? "") === "",
    );
  }

  // --- Vendor list ---

  vendorsHeading(count: number) {
    return this.page.getByText(`Vendors (${count})`, { exact: true });
  }

  emptyState() {
    return this.page.getByText("No vendors recorded yet.", { exact: true });
  }

  /** The `<li>` for a given vendor, matched by a substring of its own visible text (its name) --
   * never `exact: true` (see this file's own header comment: the name and its category badge
   * render with no separator between them, so an exact match on the bare name never matches). */
  private vendorRow(nameContains: string) {
    return this.page.locator("li").filter({ hasText: nameContains });
  }

  /** The category badge text for a vendor row -- either its mapped category label (e.g.
   * "Florist") or, for an OTHER-category vendor with a label, that free-text label instead. */
  vendorCategoryBadgeText(nameContains: string) {
    return this.vendorRow(nameContains).locator("span").first();
  }

  /** The contact line (`name · email · phone`, filtered of blanks) or the literal "No contact
   * info" fallback. */
  vendorContactLineText(nameContains: string) {
    return this.vendorRow(nameContains).locator("p").nth(1);
  }

  /** The contract-notes line -- only rendered at all when the vendor has notes on file (the third
   * `<p>` in document order within the row, after the name/badge line and the contact line). */
  vendorNotesText(nameContains: string) {
    return this.vendorRow(nameContains).locator("p").nth(2);
  }

  /** The row's own cost text -- "No cost set" or a formatted dollar amount. */
  vendorCostText(nameContains: string) {
    return this.vendorRow(nameContains).locator("span.font-medium");
  }

  private editButton(nameContains: string) {
    return this.vendorRow(nameContains).getByRole("button", { name: "Edit", exact: true });
  }
  private removeButton(nameContains: string) {
    return this.vendorRow(nameContains).getByRole("button", { name: "Remove", exact: true });
  }

  async startEdit(nameContains: string): Promise<void> {
    await this.editButton(nameContains).click();
  }

  // Not row-scoped, deliberately: once Edit is clicked, BudgetTab.tsx replaces that row's own
  // display with these inputs (matched by aria-label, since none has a visible <label>) -- exactly
  // one row can be in edit mode at a time (a single `editingId` in component state), so a
  // page-wide lookup is unambiguous, same reasoning as TimelineTabPage's edit* locators.
  private editNameInput() {
    return this.page.getByLabel("Edit vendor name", { exact: true });
  }
  private editCategorySelect() {
    return this.page.getByLabel("Edit category", { exact: true });
  }
  private editCategoryOtherInput() {
    return this.page.getByLabel("Edit category label", { exact: true });
  }
  private editCostInput() {
    return this.page.getByLabel("Edit cost", { exact: true });
  }
  private editContractNotesInput() {
    return this.page.getByLabel("Edit contract notes", { exact: true });
  }
  private saveEditButton() {
    return this.page.getByRole("button", { name: "Save", exact: true });
  }
  private cancelEditButton() {
    return this.page.getByRole("button", { name: "Cancel", exact: true });
  }

  async setEditName(name: string): Promise<void> {
    await this.editNameInput().fill(name);
  }
  async setEditCategory(label: string): Promise<void> {
    await this.editCategorySelect().selectOption({ label });
  }
  async setEditCategoryOther(label: string): Promise<void> {
    await this.editCategoryOtherInput().fill(label);
  }
  async setEditCost(dollars: string): Promise<void> {
    await this.editCostInput().fill(dollars);
  }
  async setEditContractNotes(notes: string): Promise<void> {
    await this.editContractNotesInput().fill(notes);
  }

  /** Clicks Save and waits for the PATCH to resolve, whatever its outcome (200 or a 409 conflict --
   * both leave a response for this to observe; the caller asserts what happened afterward). */
  async saveEdit(): Promise<void> {
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "PATCH" && /\/vendors\/[^/]+$/.test(new URL(res.url()).pathname),
      ),
      this.saveEditButton().click(),
    ]);
  }

  async cancelEdit(): Promise<void> {
    await this.cancelEditButton().click();
  }

  /** Waits for the DELETE to resolve before returning. The UI removes the row optimistically
   * (before the request even settles), so this wait is for callers that go on to check persisted
   * state through the API rather than for the UI update itself. */
  async remove(nameContains: string): Promise<void> {
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "DELETE" && /\/vendors\/[^/]+$/.test(new URL(res.url()).pathname),
      ),
      this.removeButton(nameContains).click(),
    ]);
  }

  // TS-52: public locator accessors for the view-only-access test -- confirming the add-vendor/
  // budget-editing forms and every per-vendor editing control are entirely ABSENT (not merely
  // disabled) from a read-only collaborator's own page, matching this framework's established
  // pattern (see TimelineTabPage's allEditButtons/allRemoveButtons).
  budgetInputLocator() {
    return this.budgetInput();
  }
  vendorNameInputLocator() {
    return this.vendorNameInput();
  }
  allEditButtons() {
    return this.page.getByRole("button", { name: "Edit", exact: true });
  }
  allRemoveButtons() {
    return this.page.getByRole("button", { name: "Remove", exact: true });
  }
}
