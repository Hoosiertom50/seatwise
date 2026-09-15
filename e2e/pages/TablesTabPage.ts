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
