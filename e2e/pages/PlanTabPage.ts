/**
 * TS-38 — page object for the wedding detail page's Seating plan tab (spec Section 7.2): the
 * "Generate new plan" action, the "Save as comparison draft" choice, and the version picker.
 * Reading the resulting assignments themselves is left to a direct API read in the test (the
 * per-table grouping this tab renders is presentation-only and considerably more complex to
 * model reliably as a page/component object than the same data the API already returns
 * structured) -- this page object covers only the real UI controls a planner actually operates.
 */

import { BasePage } from "./BasePage.js";

export class PlanTabPage extends BasePage {
  private seatingPlanTabButton() {
    return this.page.getByRole("button", { name: "Seating plan", exact: true });
  }

  private generateButton() {
    return this.page.getByRole("button", { name: /^generate new plan$|^generating\.\.\.$/i });
  }

  private saveAsDraftCheckbox() {
    return this.page.getByRole("checkbox", { name: /save as comparison draft/i });
  }

  versionSelect() {
    return this.page.locator("#plan-version-select");
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
    await this.seatingPlanTabButton().click();
  }

  /** Runs one generation. `saveAsDraft` mirrors the real "Save as comparison draft" checkbox
   * (unchecked -- the default -- makes the new version Current); waits for the button to return
   * to its ready label, which only happens after the request settles either way (success or a
   * reported conflict), so callers never race the async request. */
  async generate(saveAsDraft = false): Promise<void> {
    const checkbox = this.saveAsDraftCheckbox();
    if ((await checkbox.isChecked()) !== saveAsDraft) {
      await checkbox.click();
    }
    await this.generateButton().click();
    // The button's own accessible name flips to "Generating..." while the request is in flight
    // and back to "Generate new plan" once it settles (success or a reported conflict) -- waiting
    // for a fresh locator matching only the ready-state label is a real wait for that, not a
    // fixed sleep.
    await this.page.getByRole("button", { name: "Generate new plan", exact: true }).waitFor();
  }
}
