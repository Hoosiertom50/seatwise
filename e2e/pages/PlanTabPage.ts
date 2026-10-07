/**
 * TS-38 — page object for the wedding detail page's Seating plan tab (spec Section 7.2): the
 * "Generate new plan" action, the "Save as comparison draft" choice, and the version picker.
 * Reading the resulting assignments themselves is left to a direct API read in the test (the
 * per-table grouping this tab renders is presentation-only and considerably more complex to
 * model reliably as a page/component object than the same data the API already returns
 * structured) -- this page object covers only the real UI controls a planner actually operates.
 */

import { expect } from "@playwright/test";
import { BasePage } from "./BasePage.js";

/** TS-199: a guest's name used inside a pattern, matched literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PlanTabPage extends BasePage {
  private seatingPlanTabButton() {
    return this.page.getByRole("tab", { name: "Seating plan", exact: true });
  }

  private generateButton() {
    return this.page.getByRole("button", { name: /^generate new plan$|^generating\.\.\.$/i });
  }

  private saveAsDraftCheckbox() {
    return this.page.getByRole("checkbox", { name: /save as comparison draft/i });
  }

  /** TS-126: a table's card in the List view (every table appears, seated or not). Found by the
   * card whose heading line starts with the table's label. */
  listTableCard(label: string) {
    return this.page
      .locator("div.rounded-lg")
      .filter({ has: this.page.getByText(label, { exact: true }) })
      .filter({ hasText: /seated|seats free/ })
      .last();
  }

  /** TS-126: the card's seat summary -- "x/N seated" or "Empty — N seats free". */
  listTableSeatSummary(label: string) {
    return this.listTableCard(label).getByText(/^(\d+\/\d+ seated|Empty — \d+ seats free)$/);
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
  /** TS-116: the Approve button itself, for asserting it's disabled on an incomplete plan. */
  approveControl() {
    return this.approveButton();
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

  /** TS-199: the seating floor plan's canvas (the table boxes and the guests in them). */
  floorPlanRegion() {
    return this.page.getByRole("group", { name: "Seating floor plan", exact: true });
  }

  /** TS-199: a guest's "Move to…"/"Seat at…" list in the List view (pick a table, then press the
   * button next to it). */
  private listMoveSelect(guestName: string) {
    return this.page.getByLabel(new RegExp(`^Move ${escapeRegExp(guestName)} to (a|a different) table$`));
  }
  private listMoveButton(guestName: string) {
    return this.page.getByRole("button", { name: new RegExp(`^(Move|Seat) ${escapeRegExp(guestName)}$`) });
  }

  /** TS-199: picks a table in a guest's List-view list and presses Move/Seat, waiting for the save. */
  async moveGuestInList(guestName: string, tableLabel: string): Promise<void> {
    await this.listMoveSelect(guestName).selectOption({ label: tableLabel });
    await Promise.all([this.waitForMove(), this.listMoveButton(guestName).click()]);
  }

  /** TS-199: focuses a guest's List-view list and presses the down arrow `times` times. */
  async arrowThroughListMoveChoices(guestName: string, times: number): Promise<void> {
    await this.listMoveSelect(guestName).focus();
    for (let i = 0; i < times; i++) await this.page.keyboard.press("ArrowDown");
  }

  /** TS-199: the guest's List-view list (for focus checks) and its Move/Seat button. */
  listMoveList(guestName: string) {
    return this.listMoveSelect(guestName);
  }
  listMoveButtonFor(guestName: string) {
    return this.listMoveButton(guestName);
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

  /** TS-151: approve as someone who can approve but not edit (a Couple member with Comment
   * access) -- they get no "Reopen for review" button afterwards, so wait for the badge instead. */
  async approveAsReviewer(): Promise<void> {
    await this.approveButton().click();
    await this.statusBadge("Approved").waitFor();
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

  private waitForMove() {
    return this.page.waitForResponse((res) => res.url().includes("/assignments") && res.request().method() === "POST");
  }

  /** TS-90: a finger (or pen) drag -- real `PointerEvent`s with `pointerType: "touch"`, the only
   * input a touch browser gives this gesture (native HTML5 drag doesn't fire for a finger). Sent
   * with `dispatchEvent` rather than the Chromium-only CDP touch API, so the same gesture runs on
   * every browser project. The chip's handlers take it from there: pointerdown on the chip,
   * pointermoves past the 8px tap threshold, pointerup over the target, found by elementFromPoint. */
  async touchDragGuestToTable(guestId: string, tableId: string): Promise<void> {
    const chip = this.guestChip(guestId);
    const table = this.tableBox(tableId);
    await table.scrollIntoViewIfNeeded();
    await chip.scrollIntoViewIfNeeded();
    const from = (await chip.boundingBox())!;
    const to = (await table.boundingBox())!;
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    // Aim at the table's label strip, clear of any chips inside it.
    const end = { x: to.x + to.width / 2, y: to.y + 10 };
    const base = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true };
    await chip.dispatchEvent("pointerdown", { ...base, clientX: start.x, clientY: start.y, buttons: 1 });
    for (let i = 1; i <= 5; i++) {
      await chip.dispatchEvent("pointermove", {
        ...base,
        clientX: start.x + ((end.x - start.x) * i) / 5,
        clientY: start.y + ((end.y - start.y) * i) / 5,
        buttons: 1,
      });
    }
    await Promise.all([
      this.waitForMove(),
      chip.dispatchEvent("pointerup", { ...base, clientX: end.x, clientY: end.y, buttons: 0 }),
    ]);
  }

  /** TS-90: keyboard pick-and-place -- focus the guest, Enter to pick up, Tab to the target table,
   * Enter to place. Tabs toward the target table -- Shift+Tab when it comes earlier in the page than
   * the guest -- until it has focus. The direction matters: tabbing forward past the last element
   * wraps back to the top of the page in Chromium, but Firefox hands focus to its own browser UI
   * instead and never returns to the page (caught by TS-90's first CI run on Firefox). */
  async keyboardMoveGuestToTable(guestId: string, tableId: string): Promise<void> {
    await this.guestChip(guestId).focus();
    await this.page.keyboard.press("Enter");
    await expect(this.guestChip(guestId)).toHaveAttribute("aria-pressed", "true");
    const table = this.tableBox(tableId);
    const tableIsEarlier = await this.page.evaluate(
      ([g, t]) => {
        const chip = document.querySelector(`[data-guest-id="${g}"]`)!;
        const box = document.querySelector(`[data-table-id="${t}"]`)!;
        return Boolean(chip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_PRECEDING);
      },
      [guestId, tableId],
    );
    const key = tableIsEarlier ? "Shift+Tab" : "Tab";
    for (let i = 0; i < 50; i++) {
      if (await table.evaluate((el) => el === document.activeElement)) break;
      await this.page.keyboard.press(key);
    }
    await expect(table).toBeFocused();
    await Promise.all([this.waitForMove(), this.page.keyboard.press("Enter")]);
  }

  /** TS-90: keyboard pick-up then Escape -- leaves nothing picked and makes no move. */
  async keyboardPickUpThenCancel(guestId: string): Promise<void> {
    await this.guestChip(guestId).focus();
    await this.page.keyboard.press("Enter");
    await expect(this.guestChip(guestId)).toHaveAttribute("aria-pressed", "true");
    await this.page.keyboard.press("Escape");
  }

  /** A guest's chip on the floor plan, for state assertions (e.g. its aria-pressed pick-up state). */
  guestChipFor(guestId: string) {
    return this.guestChip(guestId);
  }

  /** TS-90: tap/click pick-and-place -- tap the guest, then tap the target table. */
  async tapMoveGuestToTable(guestId: string, tableId: string): Promise<void> {
    await this.guestChip(guestId).click();
    const table = this.tableBox(tableId);
    await table.scrollIntoViewIfNeeded();
    const box = (await table.boundingBox())!;
    await Promise.all([this.waitForMove(), this.page.mouse.click(box.x + box.width / 2, box.y + 10)]);
  }

  async undo(): Promise<void> {
    await this.undoButton().click();
  }

  async redo(): Promise<void> {
    await this.redoButton().click();
  }

  // TS-118: the plan-version screens -- status badge, nickname, comparison, score explanation,
  // and a past version's read-only notice and restore flow.
  statusBadge(label: "Draft" | "In review" | "Approved") {
    return this.page.getByText(label, { exact: true });
  }
  addNicknameButton() {
    return this.page.getByRole("button", { name: /^(Add a nickname\.\.\.|“.*” \(rename\))$/ });
  }
  nicknameInput() {
    return this.page.getByLabel("Version nickname", { exact: true });
  }
  async setNickname(value: string, save = true): Promise<void> {
    await this.addNicknameButton().click();
    await this.nicknameInput().fill(value);
    await this.page.getByRole("button", { name: save ? "Save" : "Cancel", exact: true }).click();
  }
  async cancelNicknameEdit(): Promise<void> {
    await this.page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  scoreExplanationToggle() {
    return this.page.getByRole("button", { name: /^(How is this calculated\?|Hide calculation)$/ });
  }
  async openComparison(): Promise<void> {
    await this.page.getByRole("button", { name: "Compare two versions...", exact: true }).click();
  }
  async compare(fromLabel?: RegExp, toLabel?: RegExp): Promise<void> {
    if (fromLabel) await this.selectOptionMatching(this.page.getByLabel("From", { exact: true }), fromLabel);
    if (toLabel) await this.selectOptionMatching(this.page.getByLabel("To", { exact: true }), toLabel);
    await this.page.getByRole("button", { name: "Compare", exact: true }).click();
  }
  comparisonSummary() {
    return this.page.getByText(/^v\d+.* → v\d+.*: \d+ moved, \d+ added, \d+ removed, \d+ unchanged$/);
  }
  async selectVersion(optionLabel: RegExp): Promise<void> {
    await this.selectOptionMatching(this.versionSelect(), optionLabel);
  }
  pastVersionNotice() {
    // TS-177: also shown for a comparison draft.
    return this.page.getByText(/^This isn't the current version \(it's an older one, or a comparison draft\) — status can only be changed on the current one\./);
  }
  restoreButton(versionNumber: number) {
    return this.page.getByRole("button", { name: `Restore version ${versionNumber}...`, exact: true });
  }
  restorePreview(versionNumber: number) {
    return this.page.getByText(new RegExp(`^Restoring version ${versionNumber} will create a new version`));
  }
  /** TS-208: the restore preview's note that confirming will save a comparison draft (the current
   * plan is approved and this person can't replace it). */
  restoreWillBeDraftNote() {
    return this.page.getByTestId("restore-will-be-draft");
  }
  async confirmRestore(): Promise<void> {
    await this.page.getByRole("button", { name: "Confirm restore", exact: true }).click();
  }
  async cancelRestore(): Promise<void> {
    await this.page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  /** Any status-change button (none should show on a past version). */
  statusChangeButtons() {
    return this.page.getByRole("button", { name: /^(Move to review|Move back to draft|Approve|Reopen for review)$/ });
  }
  /** The tab's red error line, matched by its text. */
  message(text: string | RegExp) {
    return typeof text === "string" ? this.page.getByText(text, { exact: true }) : this.page.getByText(text);
  }
  private async selectOptionMatching(select: ReturnType<PlanTabPage["versionSelect"]>, label: RegExp): Promise<void> {
    // TS-177: the list fills in after the tab loads -- wait for the option rather than reading it once.
    let options: string[] = [];
    await expect
      .poll(async () => {
        options = await select.locator("option").allTextContents();
        return options.some((o) => label.test(o));
      })
      .toBe(true)
      .catch(() => undefined);
    const match = options.find((o) => label.test(o));
    if (!match) throw new Error(`No option matching ${label} (have: ${options.join(" | ")})`);
    await select.selectOption({ label: match });
  }

  /** Runs one generation. `saveAsDraft` mirrors the real "Save as comparison draft" checkbox
   * (unchecked -- the default -- makes the new version Current); waits for the button to return
   * to its ready label, which only happens after the request settles either way (success or a
   * reported conflict), so callers never race the async request. */
  async generate(saveAsDraft = false): Promise<void> {
    // TS-189: the checkbox is only offered once a plan exists (the first plan is always current),
    // so wait for the tab to finish loading before deciding whether it's there.
    await this.generateButton().waitFor();
    const checkbox = this.saveAsDraftCheckbox();
    if ((await checkbox.count()) === 0) {
      if (saveAsDraft) throw new Error("PlanTabPage.generate: no comparison-draft choice before the first plan exists.");
    } else if ((await checkbox.isChecked()) !== saveAsDraft) {
      await checkbox.click();
    }
    await this.generateButton().click();
    // The button's own accessible name flips to "Generating..." while the request is in flight
    // and back to "Generate new plan" once it settles (success or a reported conflict) -- waiting
    // for a fresh locator matching only the ready-state label is a real wait for that, not a
    // fixed sleep.
    await this.page.getByRole("button", { name: "Generate new plan", exact: true }).waitFor();
  }

  /** TS-170: starts a tap-to-move without waiting for it to save (to act again while it's on its way). */
  async startTapMove(guestId: string, tableId: string): Promise<void> {
    await this.guestChip(guestId).click();
    const table = this.tableBox(tableId);
    await table.scrollIntoViewIfNeeded();
    const box = (await table.boundingBox())!;
    await this.page.mouse.click(box.x + box.width / 2, box.y + 10);
  }

  /** TS-170: clicks "Move to review" without waiting for the status to change. */
  async clickMoveToReview(): Promise<void> {
    await this.moveToReviewButton().click();
  }

  /** TS-170: the "Move back to draft" button, which appears once the plan is In review. */
  moveBackToDraftLocator() {
    return this.moveBackToDraftButton();
  }

  /** TS-179: shown after Generate or Restore by someone who can't replace an approved plan. */
  savedAsDraftNotice() {
    return this.page.getByRole("status").filter({ hasText: "saved as a comparison draft" });
  }

  /** TS-189: shown when a newer plan was made elsewhere and the tab switched to it. */
  newerPlanNotice() {
    return this.page.getByRole("status").filter({ hasText: "A newer plan was made — you're now looking at it." });
  }

  /** TS-197: what the last Generate said about its plan -- headed "Couldn't seat everyone:" when
   * someone was left unseated (with the reasons), otherwise "Notes on this plan:". */
  generateWarnings() {
    return this.page.getByTestId("plan-generate-warnings");
  }

  /** TS-197: shown when a comparison draft was asked for but there was no current plan, so the
   * new version was made the current plan. */
  madeCurrentNotice() {
    return this.page.getByRole("status").filter({ hasText: "this version was made the current plan" });
  }

  /** TS-197: the open version's "N seated, M unassigned" line. */
  seatedSummary() {
    return this.page.getByText(/^\d+ seated, \d+ unassigned$/);
  }

  /** TS-189: the open version's badge, "Version N — complete/incomplete". */
  openVersionBadge(versionNumber: number) {
    return this.page.getByText(new RegExp(`^Version ${versionNumber} — (complete|incomplete)$`));
  }

  /** TS-189: the "Save as comparison draft" choice (offered only once a plan exists). */
  comparisonDraftChoice() {
    return this.saveAsDraftCheckbox();
  }

  /** TS-179: the approved plan's PDF export buttons (shown only on the current, approved version).
   * TS-211: buttons now -- each fetches its PDF and says inline when it can't. */
  exportLinks() {
    return this.page.getByRole("button", { name: /\(PDF\)$/ });
  }

  /** TS-211: one PDF export button, by its label (e.g. "Seating chart (PDF)"). */
  exportButton(label: string) {
    return this.page.getByRole("button", { name: label, exact: true });
  }

  /** TS-211: the warning next to Export while attending guests aren't seated. */
  exportUnseatedWarning() {
    return this.page.getByTestId("export-unseated-warning");
  }

  /** TS-211: a failed export's message, shown next to the export buttons. */
  exportError(text: string | RegExp) {
    return this.page.getByRole("alert").filter({ hasText: text });
  }
}
