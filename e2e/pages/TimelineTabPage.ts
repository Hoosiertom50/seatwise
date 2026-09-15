/**
 * TS-46 (REQ-DAY-OF-TIMELINE) — page object for the wedding detail page's Timeline tab
 * (apps/web/src/app/weddings/[weddingId]/components/TimelineTab.tsx): a per-wedding chronological
 * run-of-show, entirely independent of guests/tables/rules/seating plans. Entries are always
 * listed by (time, sortOrder) from the server -- this component never sorts client-side -- so a
 * test drives ordering entirely through what's added/edited/reordered, never a client re-sort.
 * Selectors are kept private per the framework's raw-selector-in-test lint rule.
 */

import { BasePage } from "./BasePage.js";

export class TimelineTabPage extends BasePage {
  private timelineTabButton() {
    return this.page.getByRole("button", { name: "Timeline", exact: true });
  }

  private addTimeInput() {
    return this.page.locator("#entry-time");
  }
  private addDescriptionInput() {
    return this.page.locator("#entry-description");
  }
  private addButton() {
    return this.page.getByRole("button", { name: /^add to timeline$|^adding\.\.\.$/i });
  }

  /** The <li> for a given entry, matched by its (already-rendered) description text -- unique
   * per test via a `uniqueToken`-embedded description, never a raw index into the list. */
  private entryRow(description: string) {
    return this.page.locator("li").filter({ has: this.page.getByText(description, { exact: true }) });
  }

  private editButton(description: string) {
    return this.entryRow(description).getByRole("button", { name: "Edit", exact: true });
  }
  // Not row-scoped, deliberately: once Edit is clicked, TimelineTab.tsx replaces that row's own
  // description text with these very inputs -- so a row locator keyed on the (now-gone) plain
  // text can never re-resolve them. Exactly one row can be in edit mode at a time (a single
  // `editingId` in component state), so a page-wide lookup is unambiguous.
  private editTimeInput() {
    return this.page.getByLabel("Edit time", { exact: true });
  }
  private editDescriptionInput() {
    return this.page.getByLabel("Edit description", { exact: true });
  }
  private saveButton() {
    return this.page.getByRole("button", { name: "Save", exact: true });
  }
  private upButton(description: string) {
    return this.entryRow(description).getByRole("button", { name: "↑", exact: true });
  }
  private downButton(description: string) {
    return this.entryRow(description).getByRole("button", { name: "↓", exact: true });
  }
  private removeButton(description: string) {
    return this.entryRow(description).getByRole("button", { name: "Remove", exact: true });
  }

  /** The row's own formatted-time `<p>` -- confirmed in TimelineTab.tsx's `formatTime` to render
   * a 12-hour "h:mm AM/PM" label, never the raw "HH:MM" the form itself takes. */
  entryTimeText(description: string) {
    return this.entryRow(description).locator("p").first();
  }

  errorText() {
    return this.page.locator("p.text-red-600, p.text-red-400");
  }

  viewOnlyNotice() {
    return this.page.getByText(
      "You have view-only access to this wedding's timeline — adding, editing, and reordering entries is turned off.",
      { exact: true },
    );
  }

  runOfShowHeading(count: number) {
    return this.page.getByText(`Run of show (${count})`, { exact: true });
  }

  /** The full ordered list of rendered run-of-show rows -- exposed as a `Locator` for a test to
   * assert count/order against (e.g. `.nth(i)`), matching this framework's established
   * expose-a-Locator-for-the-test-to-assert-against pattern (see `BasePage.textLocator`). */
  entryRows() {
    return this.page.locator("ul li");
  }

  // TS-46: public locator accessors for the view-only-access test -- confirming the add-entry
  // form and every per-entry editing control are entirely ABSENT (not merely disabled) from a
  // read-only collaborator's own page, matching this framework's established pattern (see
  // DayOfTabPage's touch-target accessors) of a page object exposing a `Locator` for the test to
  // assert against, rather than embedding the assertion itself.
  addTimeInputLocator() {
    return this.addTimeInput();
  }
  addDescriptionInputLocator() {
    return this.addDescriptionInput();
  }
  allEditButtons() {
    return this.page.getByRole("button", { name: "Edit", exact: true });
  }
  allRemoveButtons() {
    return this.page.getByRole("button", { name: "Remove", exact: true });
  }
  allMoveUpButtons() {
    return this.page.getByRole("button", { name: "↑", exact: true });
  }
  allMoveDownButtons() {
    return this.page.getByRole("button", { name: "↓", exact: true });
  }

  /**
   * A real, reproducible race found while verifying this empirically: TimelineTab's mount effect
   * gets double-invoked (React 18 Strict Mode, on by default in Next.js dev), firing two
   * overlapping initial GETs. If the second, slower one is still in flight when a test performs a
   * mutating action right after the page settles, that GET's response -- fetched *before* the
   * action -- lands afterward and its plain `setEntries(res.entries)` silently overwrites the
   * action's own state update (optimistic removal, an edit's re-sort, ...) with stale data, even
   * though the request itself succeeded server-side. Strict Mode's double-invoke is
   * development-only (confirmed: it never happens in a production build), so this exact race is a
   * dev-server test artifact -- but it also exposes a real gap in the component itself: neither
   * fetch is sequenced or cancelled, so nothing stops an unusually slow initial load from
   * clobbering a fast, real user action the same way outside Strict Mode too. Waiting for the
   * network to go idle here (confirmed empirically to resolve it) ensures any duplicate fetch has
   * already settled before a test's first mutating action, rather than papering over it with an
   * arbitrary sleep.
   */
  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
    await this.timelineTabButton().click();
    await this.page.waitForLoadState("networkidle");
  }

  private isTimelineEntriesCollectionRequest(url: string): boolean {
    return /\/timeline-entries$/.test(new URL(url).pathname);
  }

  private isTimelineEntryItemRequest(url: string): boolean {
    return /\/timeline-entries\/[^/]+$/.test(new URL(url).pathname);
  }

  private isTimelineReorderRequest(url: string): boolean {
    return /\/timeline-entries\/[^/]+\/reorder$/.test(new URL(url).pathname);
  }

  /** Waits for the add form's own POST to resolve, and for the form's own fields to clear
   * (`onAdd`'s own state reset, confirming its `.then()` has actually run) before returning -- so
   * a caller can immediately call `addEntry` again without racing this submission's own async
   * completion against the next one's form fill. */
  async addEntry(time: string, description: string): Promise<void> {
    await this.addTimeInput().fill(time);
    await this.addDescriptionInput().fill(description);
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "POST" && this.isTimelineEntriesCollectionRequest(res.url()),
      ),
      this.addButton().click(),
    ]);
    await this.page.waitForFunction(
      () => (document.querySelector<HTMLInputElement>("#entry-description")?.value ?? "") === "",
    );
  }

  async startEdit(description: string): Promise<void> {
    await this.editButton(description).click();
  }

  /** Waits for the PATCH to resolve before returning -- onSaveEdit updates React state directly
   * from the response body (no separate refetch), so this is the only network call to wait for. */
  async saveEdit(newTime: string, newDescription: string): Promise<void> {
    await this.editTimeInput().fill(newTime);
    await this.editDescriptionInput().fill(newDescription);
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "PATCH" && this.isTimelineEntryItemRequest(res.url()),
      ),
      this.saveButton().click(),
    ]);
  }

  /** Waits for both the reorder POST and the full-list refetch GET onReorder issues afterward
   * (see TimelineTab.tsx's own comment: it refetches rather than guessing the swapped neighbor's
   * new sortOrder) -- otherwise a caller can observe the click before either request settles. */
  private async reorder(description: string, direction: "UP" | "DOWN"): Promise<void> {
    const reorderResponse = this.page.waitForResponse(
      (res) => res.request().method() === "POST" && this.isTimelineReorderRequest(res.url()),
    );
    const refetchResponse = this.page.waitForResponse(
      (res) => res.request().method() === "GET" && this.isTimelineEntriesCollectionRequest(res.url()),
    );
    await (direction === "UP" ? this.upButton(description) : this.downButton(description)).click();
    await reorderResponse;
    await refetchResponse;
  }

  async moveUp(description: string): Promise<void> {
    await this.reorder(description, "UP");
  }

  async moveDown(description: string): Promise<void> {
    await this.reorder(description, "DOWN");
  }

  async isMoveUpEnabled(description: string): Promise<boolean> {
    return this.upButton(description).isEnabled();
  }

  async isMoveDownEnabled(description: string): Promise<boolean> {
    return this.downButton(description).isEnabled();
  }

  /** Waits for the DELETE to resolve before returning. The UI itself removes the row optimistically
   * (before the request even settles), so this wait is for callers that go on to check persisted
   * state through the API rather than for the UI update itself. */
  async remove(description: string): Promise<void> {
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "DELETE" && this.isTimelineEntryItemRequest(res.url()),
      ),
      this.removeButton(description).click(),
    ]);
  }
}
