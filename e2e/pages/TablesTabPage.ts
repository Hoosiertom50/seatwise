/**
 * TS-41 — page object for the wedding-detail page's Tables tab (TablesTab.tsx). Scoped to the
 * capacity-overview strip (AC-037: Attending / Total capacity / Assigned / Remaining capacity,
 * plus the shortfall warning) -- the one place in this feature that's computed and rendered
 * client-side only, with no dedicated API field of its own, so it has to be read from the page
 * rather than a JSON response.
 */

import { expect } from "@playwright/test";
import { BasePage } from "./BasePage.js";

export class TablesTabPage extends BasePage {
  private tablesTabButton() {
    return this.page.getByRole("button", { name: "Tables", exact: true });
  }

  // TS-51 (REQ-REUSABLE-TEMPLATES): the "Save as a reusable template" `<details>` section.
  // Real finding, confirmed against the live page's own accessibility snapshot: although the
  // HTML-AAM spec says a `<summary>` (as a `<details>`'s first child) maps to ARIA role "button",
  // this app's actual rendered `<summary>` here computes to the generic "generic" role instead
  // (no accessible "button" role at all) -- so `getByRole("button", ...)` never matches and hangs
  // until the test timeout, rather than failing fast. Matched by its own visible text instead,
  // same as this framework's established pattern for the analogous no-stable-id list rows
  // (DashboardPage's weddingLink/templateRow).
  private saveAsTemplateSummary() {
    return this.page.getByText("Save as a reusable template", { exact: true });
  }
  private templateNameInput() {
    return this.page.locator("#template-name");
  }
  private saveAsTemplateButton() {
    return this.page.getByRole("button", { name: /^save as template$|^saving\.\.\.$/i });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
  }

  async openTablesTab(): Promise<void> {
    await this.tablesTabButton().click();
  }

  // TS-55 (REQ-INTEGRATION-E2E-SCENARIOS): the "Quick-create a standard set of tables" `<details>`
  // section (FR-4.2) -- same collapsed-`<summary>` shape as `saveAsTemplateSummary` above (and the
  // same real finding: matched by its own text, never `getByRole("button", ...)`, which never
  // matches this app's rendered `<summary>`).
  private quickCreateSummary() {
    return this.page.getByText("Quick-create a standard set of tables", { exact: true });
  }
  private quickCreateCountInput() {
    return this.page.locator("#qc-count");
  }
  private quickCreateCapacityInput() {
    return this.page.locator("#qc-capacity");
  }
  private quickCreateSubmitButton() {
    // The button's own accessible name is dynamic ("Create {n} {shape} table(s) of {capacity}"
    // while idle, "Creating..." in flight) -- confirmed directly in TablesTab.tsx's onQuickCreate
    // form -- so this matches on the one word common to every idle/in-flight label instead of the
    // full text.
    return this.page.getByRole("button", { name: /^Create \d+|^Creating\.\.\.$/ });
  }

  /** Expands the collapsed quick-create section, fills how-many/seats-each (leaving shape and name
   * prefix at their own defaults), and submits -- waits for the button to return to its own idle,
   * "Create ..." label, which only happens once the request has settled. */
  async quickCreateTables(count: number, capacity: number): Promise<void> {
    await this.quickCreateSummary().click();
    await this.quickCreateCountInput().fill(String(count));
    await this.quickCreateCapacityInput().fill(String(capacity));
    await this.quickCreateSubmitButton().click();
    await this.page.getByRole("button", { name: /^Create \d+/ }).waitFor();
  }

  /** Reads one of the capacity-overview strip's stat values (Attending, Total capacity, Assigned,
   * Remaining capacity) as a number. Each label and its value are sibling `<p>` elements sharing
   * one parent `<div>` -- read via the label's very next `<p>` sibling, not by filtering an
   * ancestor `<div>` for the label text, since the whole four-stat strip shares one outer grid
   * `<div>` too and a `has:` filter would match that ancestor as well, returning every stat's
   * value instead of just this one's. */
  private statValue(label: string) {
    return this.page.getByText(label, { exact: true }).locator("xpath=following-sibling::p");
  }

  async attendingCount(): Promise<number> {
    return Number(await this.statValue("Attending").innerText());
  }

  async totalCapacity(): Promise<number> {
    return Number(await this.statValue("Total capacity").innerText());
  }

  async assignedCount(): Promise<number> {
    return Number(await this.statValue("Assigned").innerText());
  }

  async remainingCapacity(): Promise<number> {
    return Number(await this.statValue("Remaining capacity").innerText());
  }

  /** The non-blocking shortfall warning ("Short N seat(s) for everyone attending — ..."), only
   * rendered at all once Attending headcount exceeds total capacity. */
  shortfallWarning() {
    return this.page.getByText(/Short \d+ seat/);
  }

  // TS-110: the optional FR-4.3 floor plan (TablesTab.tsx's `FloorPlan`). Each table box has no
  // role or id of its own; its `title` attribute ("<label> — <n> seats...") is the one stable,
  // user-meaningful handle, so boxes are matched by that title's leading label.
  async openFloorPlan(): Promise<void> {
    await this.page.getByRole("button", { name: "Floor plan", exact: true }).click();
  }

  /** Any message the tab shows the user (e.g. its red error banner), matched by its text -- a
   * string matches the whole element text exactly, so the same reason echoed inside the header's
   * save status ("Not saved: <reason>", TS-93) isn't a second match. */
  message(text: string | RegExp) {
    return typeof text === "string" ? this.page.getByText(text, { exact: true }) : this.page.getByText(text);
  }

  /** TS-124: the row's Remove button (accessible name "Remove <label>"). */
  async removeTable(label: string): Promise<void> {
    await this.page.getByRole("button", { name: `Remove ${label}`, exact: true }).click();
  }

  /** TS-124: the in-row question shown when guests are seated at the table being removed. */
  removalConfirmation() {
    return this.page.getByRole("alert").filter({ hasText: "in the current plan. Removing it will leave them unassigned." });
  }

  async confirmTableRemoval(): Promise<void> {
    await this.removalConfirmation().getByRole("button", { name: "Remove anyway", exact: true }).click();
  }

  async keepTable(): Promise<void> {
    await this.removalConfirmation().getByRole("button", { name: "Keep table", exact: true }).click();
  }

  /** TS-120: the row's Edit button and the in-place form it opens (named "Edit <label>"). */
  editTableButton(label: string) {
    return this.page.getByRole("button", { name: `Edit ${label}`, exact: true });
  }

  editForm(label: string) {
    return this.page.getByRole("form", { name: `Edit ${label}`, exact: true });
  }

  async openTableEdit(label: string): Promise<void> {
    await this.editTableButton(label).click();
    await this.editForm(label).waitFor();
  }

  /** Fills whichever fields are given in the open edit form for `label` (unset ones untouched). */
  async fillTableEdit(
    label: string,
    fields: { name?: string; seats?: number; shape?: string; purpose?: string; favors?: string; favorsWhich?: string; restricted?: boolean; requiredGuests?: string[] },
  ): Promise<void> {
    const form = this.editForm(label);
    if (fields.name !== undefined) await form.getByLabel("Table name", { exact: true }).fill(fields.name);
    if (fields.seats !== undefined) await form.getByLabel("Seats", { exact: true }).fill(String(fields.seats));
    if (fields.shape !== undefined) await form.getByLabel("Shape", { exact: true }).selectOption({ label: fields.shape });
    if (fields.purpose !== undefined) await form.getByLabel("Purpose (optional)", { exact: true }).fill(fields.purpose);
    if (fields.favors !== undefined) await form.getByLabel("Favors", { exact: true }).selectOption({ label: fields.favors });
    if (fields.favorsWhich !== undefined) await form.getByLabel("Favors which", { exact: true }).selectOption({ label: fields.favorsWhich });
    if (fields.restricted !== undefined) await form.getByLabel(/^Restricted — only the guests chosen below sit here$/).setChecked(fields.restricted);
    if (fields.requiredGuests !== undefined) {
      const group = form.getByRole("group", { name: `Required guests for ${label}` });
      for (const box of await group.getByRole("checkbox").all()) await box.setChecked(false);
      for (const name of fields.requiredGuests) await group.getByRole("checkbox", { name, exact: true }).check();
    }
  }

  async saveTableEdit(label: string): Promise<void> {
    await this.editForm(label).getByRole("button", { name: "Save changes", exact: true }).click();
  }

  async cancelTableEdit(label: string): Promise<void> {
    await this.editForm(label).getByRole("button", { name: "Cancel", exact: true }).click();
  }

  /** The tab's amber warnings panel (e.g. guests flagged Needs Reassignment after an edit). */
  warning(text: string | RegExp) {
    return this.page.getByText(text);
  }

  /** The Remove button for a table -- present while its row is listed. */
  removeTableButton(label: string) {
    return this.page.getByRole("button", { name: `Remove ${label}`, exact: true });
  }

  floorPlanTable(label: string) {
    return this.page.locator(`[title^="${label} — "]`);
  }

  /** The box's rendered position inside the floor-plan canvas, read from its inline `left`/`top`
   * style -- exactly what `FloorPlan.positionFor()` resolved for it. */
  async floorPlanTablePosition(label: string): Promise<{ x: number; y: number }> {
    return this.floorPlanTable(label).evaluate((el) => ({
      x: parseFloat((el as HTMLElement).style.left),
      y: parseFloat((el as HTMLElement).style.top),
    }));
  }

  /** Drags a table box by (dx, dy) with real pointer events -- the same pointerdown/move/up
   * sequence FloorPlan listens for -- in several steps so every intermediate move registers. */
  async dragFloorPlanTable(label: string, dx: number, dy: number): Promise<void> {
    // The floor plan sits below the tab's add-table form, so it's usually off-screen -- and
    // `page.mouse` works in viewport coordinates, which only hit the box once it's scrolled in.
    await this.floorPlanTable(label).scrollIntoViewIfNeeded();
    const box = await this.floorPlanTable(label).boundingBox();
    if (!box) throw new Error(`Floor-plan table "${label}" is not visible`);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    await this.page.mouse.move(startX + dx, startY + dy, { steps: 8 });
    await this.page.mouse.up();
  }

  /** TS-91: opens "Add tables from a template", picks the saved template whose option label starts
   * with `templateName`, adds it, and waits for the confirmation line (only shown once the request
   * has settled). */
  async addTablesFromTemplate(templateName: string): Promise<void> {
    await this.page.getByText("Add tables from a template", { exact: true }).click();
    const select = this.page.locator("#apply-template");
    await select.waitFor();
    const value = await select.locator("option", { hasText: templateName }).getAttribute("value");
    await select.selectOption(value!);
    await this.page.getByRole("button", { name: "Add these tables", exact: true }).click();
    await expect(this.page.getByText(/^Added \d+ tables? from/)).toBeVisible();
  }

  // TS-51 (REQ-REUSABLE-TEMPLATES, FR-14.1): expands the collapsed "Save as a reusable template"
  // section, fills its name field, submits, and waits for the success banner -- mirrors this
  // framework's established "fill + submit + wait for the real confirming effect" page-object
  // pattern rather than just waiting for the click to register.
  async saveAsTemplate(name: string): Promise<void> {
    await this.saveAsTemplateSummary().click();
    await this.templateNameInput().fill(name);
    await this.saveAsTemplateButton().click();
    await expect(this.page.getByText(`Saved “${name}”`, { exact: false })).toBeVisible();
  }
}
