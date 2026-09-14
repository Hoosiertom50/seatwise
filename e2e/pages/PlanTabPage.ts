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

  // TS-43 (AC-047): the List/Floor plan toggle -- exact visible button text, see PlanTab.tsx.
  private listViewButton() {
    return this.page.getByRole("button", { name: "List", exact: true });
  }
  private floorPlanViewButton() {
    return this.page.getByRole("button", { name: "Floor plan", exact: true });
  }

  // TS-43 (AC-050/AC-051/AC-052): the status-transition controls. Rendered only when
  // `detail.isCurrent && canEdit` (canEdit === OWNER or EDIT access level) -- a Couple member at
  // Comment-only access, whom the API itself allows to Approve, never sees this block at all; see
  // this story's plan-review.only-owner-or-couple-member-can-approve.spec.ts for that gap.
  private moveToReviewButton() {
    return this.page.getByRole("button", { name: "Move to review", exact: true });
  }
  private moveBackToDraftButton() {
    return this.page.getByRole("button", { name: "Move back to draft", exact: true });
  }
  private approveButton() {
    return this.page.getByRole("button", { name: "Approve", exact: true });
  }
  private reopenForReviewButton() {
    return this.page.getByRole("button", { name: "Reopen for review", exact: true });
  }

  modifiedSinceApprovalBanner() {
    return this.page.getByText("Modified since approval", { exact: true });
  }

  /** The full "First change {time}, latest {time}." detail paragraph beneath the banner heading
   * -- a test asserts specific timestamp text against this rather than the heading itself. */
  modifiedSinceApprovalDetail() {
    return this.page.getByText(/^First change /);
  }

  // TS-43 (AC-047): the "Unassigned guests" (List view) / "Unassigned — drag onto a table"
  // (Floor plan view) area -- same heading-then-container shape in both, matched by the leading
  // word so it works regardless of which view is currently showing.
  unassignedArea() {
    return this.page.getByText(/^unassigned/i).locator("..");
  }

  // TS-43 (AC-047): the "Needs reassignment" (List view) / "Needs reassignment — drag onto a
  // table" (Floor plan view) area, same shape as unassignedArea() above.
  needsReassignmentArea() {
    return this.page.getByText(/^needs reassignment/i).locator("..");
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
    await this.seatingPlanTabButton().click();
  }

  async showListView(): Promise<void> {
    await this.listViewButton().click();
  }

  async showFloorPlanView(): Promise<void> {
    await this.floorPlanViewButton().click();
  }

  async moveToReview(): Promise<void> {
    await this.moveToReviewButton().click();
    await this.moveBackToDraftButton().waitFor();
  }

  async moveBackToDraft(): Promise<void> {
    await this.moveBackToDraftButton().click();
    await this.moveToReviewButton().waitFor();
  }

  async approve(): Promise<void> {
    await this.approveButton().click();
    await this.reopenForReviewButton().waitFor();
  }

  async reopenForReview(): Promise<void> {
    await this.reopenForReviewButton().click();
    await this.moveBackToDraftButton().waitFor();
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
