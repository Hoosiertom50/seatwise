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

  // TS-44 (AC-053/AC-054/AC-055/AC-056): the Floor plan view's guest chips and table boxes --
  // confirmed directly in PlanTab.tsx's PlanFloorPlan component to be genuine native HTML5
  // drag-and-drop (onDragStart sets dataTransfer with "text/plain" = guestId; onDrop reads it
  // back and calls the same onMoveGuest the list view's dropdowns use). No data-testid exists on
  // either element, so selection is by the raw data attribute the component itself renders.
  private guestChip(guestId: string) {
    return this.page.locator(`[data-guest-id="${guestId}"]`);
  }
  private tableBox(tableId: string) {
    return this.page.locator(`[data-table-id="${tableId}"]`);
  }

  /** The plain red error paragraph PlanTab.tsx renders for a blocked/failed move (no
   * data-testid or role -- just `{error && <p>...}`); a test matches specific wording against
   * this rather than a generic "did something turn red" check. */
  moveErrorText() {
    return this.page.locator("p.text-red-600, p.text-red-400");
  }

  /** The "That move was made, but note:" banner PlanTab.tsx shows for a move that succeeded but
   * triggered a soft-rule (AVOID) warning -- distinct from `detail.warnings` (the plan-wide notes
   * shown right after generation), which uses the same styling but a different heading. */
  moveWarningsBanner() {
    return this.page.getByText("That move was made, but note:", { exact: true }).locator("..");
  }

  private undoButton() {
    return this.page.getByTestId("undo-button");
  }
  private redoButton() {
    return this.page.getByTestId("redo-button");
  }

  /** True once at least one manual move has been made this session (mirrors the UI's own
   * `undoStack.length > 0 || redoStack.length > 0` gate on rendering the Undo/Redo row at all). */
  async undoRedoRowVisible(): Promise<boolean> {
    return (await this.undoButton().count()) > 0;
  }

  /**
   * Drags a guest chip onto a table box via a real native HTML5 DnD event sequence sharing one
   * `DataTransfer` handle across dragstart/dragenter/dragover/drop/dragend -- deliberately not
   * Playwright's `locator.dragTo()` (which synthesizes mouse-only movement and never fires real
   * `dragstart`/`drop` DragEvents with a populated `dataTransfer`), since `onGuestDragStart` and
   * `onTableDrop` both read `event.dataTransfer` directly. This mirrors the deterministic-over-
   * flaky-gesture preference this framework already established for hard-rule testing (see
   * cross-cutting-invariant.hard-rules-block-every-direct-manual-move.spec.ts's own header
   * comment on exercising the underlying endpoint directly rather than a UI gesture wherever the
   * gesture itself isn't what's under test) -- here the gesture *is* what's under test, so the
   * sequence is made real and reliable rather than skipped.
   */
  async dragGuestToTable(guestId: string, tableId: string): Promise<void> {
    const chip = this.guestChip(guestId);
    const table = this.tableBox(tableId);
    await chip.scrollIntoViewIfNeeded();
    await table.scrollIntoViewIfNeeded();
    // `bubbles`/`cancelable` must be passed explicitly -- confirmed empirically that Playwright's
    // dispatchEvent does not default a "dragstart"/"dragover"/"drop" DragEvent to bubble the way a
    // real OS-driven drag does, and this app's handlers are attached above these elements via
    // React's own root-level event delegation, so a non-bubbling synthetic event never reaches
    // them at all (the drop silently no-ops with no error).
    const dataTransfer = await this.page.evaluateHandle(() => new DataTransfer());
    const init = { dataTransfer, bubbles: true, cancelable: true };
    await chip.dispatchEvent("dragstart", init);
    await table.dispatchEvent("dragenter", init);
    await table.dispatchEvent("dragover", init);
    // The drop fires `onMoveGuest`, an async call to `POST .../assignments` -- waiting for that
    // response (rather than returning as soon as the synthetic DOM event is dispatched) is what
    // makes this method safe to immediately follow with either a UI or an API assertion.
    await Promise.all([
      this.page.waitForResponse((res) => res.url().includes("/assignments") && res.request().method() === "POST"),
      table.dispatchEvent("drop", init),
    ]);
    await chip.dispatchEvent("dragend", init);
  }

  async undo(): Promise<void> {
    await this.undoButton().click();
  }

  async redo(): Promise<void> {
    await this.redoButton().click();
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
