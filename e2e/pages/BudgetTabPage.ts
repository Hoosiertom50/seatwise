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
import { ConfirmDelete } from "../components/ConfirmDelete.js";

export interface AddVendorInput {
  name: string;
  category?: string;
  categoryOther?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  cost?: string;
  contractNotes?: string;
  /** TS-114: "HH:MM", 24-hour. */
  arrivalTime?: string;
}

export class BudgetTabPage extends BasePage {
  private budgetTabButton() {
    return this.page.getByRole("tab", { name: "Budget", exact: true });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
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

  /** TS-92: what the budget box itself currently holds (e.g. after a refused save shows the
   * latest figure). */
  async budgetInputValue(): Promise<string> {
    return this.budgetInput().inputValue();
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
    if (input.arrivalTime !== undefined) {
      await this.page.locator("#vendor-arrival-time").fill(input.arrivalTime);
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

  // --- TS-97: suggestions from the planner's other weddings ---

  /** Types into the vendor name box without submitting, so suggestions can show. */
  async typeVendorName(text: string): Promise<void> {
    await this.vendorNameInput().fill(text);
  }

  /** Every "Use … from your other weddings" suggestion button currently shown. */
  vendorSuggestions() {
    return this.page.getByRole("button", { name: / from your other weddings$/ });
  }
  vendorSuggestion(name: string) {
    return this.page.getByRole("button", { name: `Use ${name} from your other weddings`, exact: true });
  }
  suggestionFilledNotice() {
    return this.page.getByRole("status").filter({ hasText: "from your other weddings" });
  }

  /** What the Add-a-vendor form's fields currently hold (category as its visible label). */
  async addFormValues(): Promise<Record<string, string>> {
    return {
      name: await this.vendorNameInput().inputValue(),
      category: ((await this.categorySelect().locator("option:checked").textContent()) ?? "").trim(),
      contactName: await this.contactNameInput().inputValue(),
      contactEmail: await this.contactEmailInput().inputValue(),
      contactPhone: await this.contactPhoneInput().inputValue(),
      cost: await this.costInput().inputValue(),
      contractNotes: await this.notesInput().inputValue(),
      arrivalTime: await this.page.locator("#vendor-arrival-time").inputValue(),
    };
  }

  /** Submits the form as it stands (e.g. after picking a suggestion), waiting like addVendor. */
  async submitAddVendor(): Promise<void> {
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

  // TS-114: a vendor's private read-only link.
  shareLinkButton(vendorName: string) {
    return this.page.getByRole("button", { name: `Share link for ${vendorName}`, exact: true });
  }
  newLinkButton(vendorName: string) {
    return this.page.getByRole("button", { name: `New link for ${vendorName}`, exact: true });
  }
  /** TS-214: the "Make a new link…?" question New link opens, scoped to the vendor's row. */
  newLinkQuestion(vendorName: string): ConfirmDelete {
    return new ConfirmDelete(this.vendorRow(vendorName));
  }
  /** Clicks Share link (or New link) and returns the link the row then shows. */
  async getShareLink(vendorName: string, fresh = false): Promise<string> {
    const button = fresh ? this.newLinkButton(vendorName) : this.shareLinkButton(vendorName);
    const [response] = await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === "POST" && /\/share-link$/.test(new URL(r.url()).pathname)),
      (async () => {
        await button.click();
        // TS-214: New link asks first ("Yes, make a new link").
        if (fresh) await new ConfirmDelete(this.vendorRow(vendorName)).confirm();
      })(),
    ]);
    // TS-176: the link comes from the server's answer, and the row is waited on until it shows
    // that link -- reading the row straight after the answer sometimes caught the old link before
    // the screen had redrawn (a flaky "new link is the same as the old one").
    const url = ((await response.json()) as { link: { url: string } }).link.url;
    await expect(this.vendorRow(vendorName).getByText(url)).toBeVisible();
    return url;
  }
  async turnOffShareLink(vendorName: string): Promise<void> {
    await this.page.getByRole("button", { name: `Turn off the link for ${vendorName}`, exact: true }).click();
    await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === "DELETE" && /\/share-link$/.test(new URL(r.url()).pathname)),
      new ConfirmDelete(this.vendorRow(vendorName)).confirm(),
    ]);
  }

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
    // TS-175: named for the vendor ("Edit <name>").
    return this.vendorRow(nameContains).getByRole("button", { name: /^Edit / });
  }
  private removeButton(nameContains: string) {
    return this.vendorRow(nameContains).getByRole("button", { name: /^Remove / });
  }

  async startEdit(nameContains: string): Promise<void> {
    await this.editButton(nameContains).click();
  }

  // Not row-scoped, deliberately: once Edit is clicked, BudgetTab.tsx replaces that row's own
  // display with these inputs -- exactly one row can be in edit mode at a time (a single
  // `editingId` in component state), so a page-wide lookup is unambiguous, same reasoning as
  // TimelineTabPage's edit* locators. TS-212: the boxes now have visible labels ("Vendor name",
  // "Cost ($)"...) that repeat the Add form's, so they're found by their ids
  // (vendor-<id>-edit-<field>) rather than by label.
  private editField(field: string) {
    return this.page.locator(`[id^="vendor-"][id$="-edit-${field}"]`);
  }
  private editNameInput() {
    return this.editField("name");
  }
  private editCategorySelect() {
    return this.editField("category");
  }
  private editCategoryOtherInput() {
    return this.editField("category-label");
  }
  private editCostInput() {
    return this.editField("cost");
  }
  private editContractNotesInput() {
    return this.editField("notes");
  }
  /** TS-212: the open edit box's visible label for a field (e.g. "Cost ($)"), as a screen reader reads it. */
  editFieldByVisibleLabel(label: string) {
    return this.page.locator("li").getByLabel(label, { exact: true });
  }
  /** TS-212: a vendor's Edit button (named "Edit <vendor>"). */
  editButtonLocator(nameContains: string) {
    return this.editButton(nameContains);
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
  /** TS-151: types the edit cost one key at a time, the way a person does (fill() sets it at once). */
  async typeEditCost(dollars: string): Promise<void> {
    await this.editCostInput().fill("");
    await this.editCostInput().pressSequentially(dollars);
  }
  async editCostValue(): Promise<string> {
    return this.editCostInput().inputValue();
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

  /** TS-180: like saveEdit, and returns what the Save actually sent (only changed fields go). */
  async saveEditReturningSentFields(): Promise<Record<string, unknown>> {
    const [request] = await Promise.all([
      this.page.waitForRequest((req) => req.method() === "PATCH" && /\/vendors\/[^/]+$/.test(new URL(req.url()).pathname)),
      this.saveEdit(),
    ]);
    return (request.postDataJSON() ?? {}) as Record<string, unknown>;
  }

  /** TS-175: how many vendor edit forms are open (0 once a conflict has closed the editor). */
  async editCostInputCount(): Promise<number> {
    return this.editCostInput().count();
  }
  /** TS-175: clicks Save without waiting for a request -- for a value the screen refuses itself. */
  async clickSaveEdit(): Promise<void> {
    await this.saveEditButton().click();
  }

  async cancelEdit(): Promise<void> {
    await this.cancelEditButton().click();
  }

  /** Waits for the DELETE to resolve before returning. The UI removes the row optimistically
   * (before the request even settles), so this wait is for callers that go on to check persisted
   * state through the API rather than for the UI update itself. */
  async remove(nameContains: string): Promise<void> {
    // TS-136: Remove asks first; the DELETE is only sent once "Yes" is clicked.
    await this.removeButton(nameContains).click();
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "DELETE" && /\/vendors\/[^/]+$/.test(new URL(res.url()).pathname),
      ),
      new ConfirmDelete(this.vendorRow(nameContains)).confirm(),
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
    return this.page.getByRole("button", { name: /^Edit / });
  }
  allRemoveButtons() {
    return this.page.getByRole("button", { name: /^Remove / });
  }
}
