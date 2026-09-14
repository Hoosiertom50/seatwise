/**
 * TS-41 — page object for the wedding-detail page's Tables tab (TablesTab.tsx). Scoped to the
 * capacity-overview strip (AC-037: Attending / Total capacity / Assigned / Remaining capacity,
 * plus the shortfall warning) -- the one place in this feature that's computed and rendered
 * client-side only, with no dedicated API field of its own, so it has to be read from the page
 * rather than a JSON response.
 */

import { BasePage } from "./BasePage.js";

export class TablesTabPage extends BasePage {
  private tablesTabButton() {
    return this.page.getByRole("button", { name: "Tables", exact: true });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
  }

  async openTablesTab(): Promise<void> {
    await this.tablesTabButton().click();
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
}
