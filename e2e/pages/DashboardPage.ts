/**
 * TS-37 — page object for `/dashboard` ("Your weddings"): the planner's own wedding list and the
 * inline create-wedding form (spec Section 7.2). No stable `id`/`data-testid` exists for the
 * per-wedding list link, so `weddingLink` filters on the link's own visible text (the wedding
 * name is always a unique, human-chosen string in this app, and this framework's own
 * `uniqueTitle` test-data helper guarantees the name passed to `createWedding` is unique across
 * tests) rather than inventing a new attribute on the app for this.
 */

import { expect } from "@playwright/test";
import { BasePage } from "./BasePage.js";

export interface CreateWeddingInput {
  name: string;
  date?: string;
  venueName?: string;
  note?: string;
}

export class DashboardPage extends BasePage {
  private nameInput() {
    return this.page.locator("#new-wedding-name");
  }

  private dateInput() {
    return this.page.locator("#new-wedding-date");
  }

  private venueInput() {
    return this.page.locator("#new-wedding-venue");
  }

  private addNoteToggle() {
    return this.page.getByRole("button", { name: "+ Add a note" });
  }

  private noteInput() {
    return this.page.locator("#new-wedding-note");
  }

  private addWeddingButton() {
    return this.page.getByRole("button", { name: /add wedding|adding\.\.\./i });
  }

  private logoutButton() {
    return this.page.getByRole("button", { name: "Log out" });
  }

  // TS-49 (REQ-PLANNER-PORTFOLIO, FR-11.1): search/filter/sort controls, each with its own
  // `aria-label` (there's no accompanying visible <label> element for any of the three).
  private searchInput() {
    return this.page.getByLabel("Search weddings", { exact: true });
  }
  private planStatusFilterSelect() {
    return this.page.getByLabel("Filter by plan status", { exact: true });
  }
  private sortSelect() {
    return this.page.getByLabel("Sort weddings", { exact: true });
  }

  // TS-51 (REQ-REUSABLE-TEMPLATES, FR-14.4): the create-wedding form's optional "start from a
  // template" section -- only rendered at all once the planner has >=1 template. The rule-shape
  // checkbox's own label text includes the template's Side-Mixing setting rendered inline (e.g.
  // "Use its rule-shape (Keep sides separate)"), so it's matched by a prefix regex rather than an
  // exact string a caller would have to reconstruct.
  private templateSelect() {
    return this.page.getByLabel("Start from a template (optional)", { exact: true });
  }
  private applyTemplateTablesCheckbox() {
    return this.page.getByLabel("Use its table layout", { exact: true });
  }
  private applyTemplateRulesCheckbox() {
    return this.page.getByLabel(/^Use its rule-shape/);
  }

  async goto(): Promise<void> {
    await this.page.goto("/dashboard");
  }

  /** The list link for a wedding whose visible name contains this text. Also carries the row's
   * plan-status badge and (for a shared wedding) a "Shared with you" badge as sibling text within
   * the same link — `hasText` does substring containment against all of it, which is fine as long
   * as the name itself (the caller's responsibility to make unique) doesn't collide with another
   * visible wedding's name. */
  weddingLink(nameContains: string) {
    return this.page.locator("li a").filter({ hasText: nameContains });
  }

  /** TS-49: every currently-visible wedding row's own link, in the exact DOM order the app
   * rendered them — a test asserting sort order finds each expected name's position in
   * `await weddingLinks().allTextContents()` rather than this page object guessing at a "name"
   * substring out of the same blob of text `weddingLink` itself warns about. Template list items
   * (inside the "Your templates" `<details>`) are never `<a>` elements -- only a `Delete`
   * `<button>` -- so this selector can never accidentally pick one up. */
  weddingLinks() {
    return this.page.locator("li a");
  }

  /** TS-49 (FR-11.1): fills the search box. Left empty (`""`) clears it back to showing everyone. */
  async search(term: string): Promise<void> {
    await this.searchInput().fill(term);
  }

  /** TS-49 (FR-11.1): the plan-status filter dropdown's underlying value
   * (`"ALL"|"NONE"|"DRAFT"|"IN_REVIEW"|"APPROVED"`), not its visible label text. */
  async filterByPlanStatus(value: "ALL" | "NONE" | "DRAFT" | "IN_REVIEW" | "APPROVED"): Promise<void> {
    await this.planStatusFilterSelect().selectOption(value);
  }

  /** TS-49 (FR-11.1/FR-11.3): the sort dropdown's underlying value -- `"urgency"` is the app's own
   * default on every page load, never persisted, so a test that changes it and wants the default
   * back must select `"urgency"` again explicitly rather than assuming a reload restores it. */
  async sortBy(value: "urgency" | "name" | "eventDate" | "guestCount" | "issues"): Promise<void> {
    await this.sortSelect().selectOption(value);
  }

  /** TS-51: every option currently offered by the template picker, in DOM order, including the
   * always-present "Start from scratch" first option -- read as plain text so a test can assert
   * the exact `"{name} ({n} tables[ · from {source}])"` label format without needing its own
   * locator into the `<select>`'s options. The whole "start from a template" section (this
   * `<select>` included) is conditionally rendered only once the dashboard's own `useEffect` GET
   * .../api/v1/templates resolves -- a real network round trip after navigation, not something
   * present in the initial render -- so this waits for the picker to actually appear before
   * reading its options; `allTextContents()` itself does not wait, and a call to it before that
   * fetch resolves would return `[]`, not retry. */
  async templateOptionTexts(): Promise<string[]> {
    await expect(this.templateSelect()).toBeVisible();
    return this.templateSelect().locator("option").allTextContents();
  }

  /** TS-51 (FR-14.4): picks a template by its id in the create-wedding form's picker, which reveals
   * the "Use its table layout" / "Use its rule-shape" checkboxes (both default checked). Passing
   * `""` selects "Start from scratch" instead, hiding those checkboxes again. */
  async selectTemplate(templateId: string): Promise<void> {
    await this.templateSelect().selectOption(templateId);
  }

  async setApplyTemplateTables(checked: boolean): Promise<void> {
    await this.applyTemplateTablesCheckbox().setChecked(checked);
  }

  async setApplyTemplateRules(checked: boolean): Promise<void> {
    await this.applyTemplateRulesCheckbox().setChecked(checked);
  }

  /** The client-side validation text shown (and "Add wedding" disabled) once a template is picked
   * but both apply checkboxes are unchecked -- pre-empts the server's own 422 for the same case. */
  pickAtLeastOneWarning() {
    return this.page.getByText("Pick at least one, or choose", { exact: false });
  }

  async isAddWeddingDisabled(): Promise<boolean> {
    return this.addWeddingButton().isDisabled();
  }

  // TS-51: the "Your templates (N)" management list -- only rendered once the planner has >=1
  // template. Each row has no stable id/testid, so it's matched the same way `weddingLink` matches
  // a wedding row: by its own visible text (the template name, which the caller is responsible for
  // making unique). The `<summary>` toggling this section, same real finding as
  // TablesTabPage.saveAsTemplateSummary: it does not compute to ARIA role "button" in this app's
  // actual rendered DOM, so it's matched by its own text instead of getByRole("button", ...).
  private templatesListSummary() {
    return this.page.getByText(/^Your templates \(\d+\)$/);
  }
  private templateRow(nameContains: string) {
    return this.page.locator("li").filter({ hasText: nameContains });
  }

  async openTemplatesList(): Promise<void> {
    await this.templatesListSummary().click();
  }

  templateRowText(nameContains: string) {
    return this.templateRow(nameContains);
  }

  /** TS-51: deletes a template from the management list by name (no confirmation dialog exists for
   * this action in the real UI, so a single click is the whole interaction) and waits for its row
   * to actually disappear rather than just for the click to register. */
  async deleteTemplate(nameContains: string): Promise<void> {
    await this.templateRow(nameContains).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(this.templateRow(nameContains)).toHaveCount(0);
  }

  /** The "Showing {n} of {m} weddings." summary line, only rendered while a search term or a
   * non-"ALL" plan-status filter is active. */
  resultsSummary() {
    return this.page.getByText(/^Showing \d+ of \d+ weddings\.$/);
  }

  /** The empty-state message shown when a search/filter combination matches nothing (distinct from
   * the separate "No weddings yet" message shown when the account has no weddings at all). */
  noMatchesMessage() {
    return this.page.getByText("No weddings match your search/filter.", { exact: true });
  }

  /** Business-readable operation: fill and submit the inline create-wedding form. Waits for the
   * new wedding to actually appear in the list rather than just for the click to register, so
   * callers never race the form's own async submit handler. */
  async createWedding(input: CreateWeddingInput): Promise<void> {
    await this.nameInput().fill(input.name);
    if (input.date) await this.dateInput().fill(input.date);
    if (input.venueName) await this.venueInput().fill(input.venueName);
    if (input.note) {
      await this.addNoteToggle().click();
      await this.noteInput().fill(input.note);
    }
    await this.addWeddingButton().click();
    await expect(this.weddingLink(input.name)).toBeVisible();
  }

  /** Clicks a wedding's list link and waits for the resulting navigation to its detail page. */
  async openWedding(nameContains: string): Promise<void> {
    await this.weddingLink(nameContains).click();
    await this.page.waitForURL(/\/weddings\/[^/]+$/);
  }

  async logout(): Promise<void> {
    await this.logoutButton().click();
  }
}
