/**
 * TS-37 — page object for the shared shell of `/weddings/:weddingId` (the page every tab, e.g.
 * `WeddingGuestsPage`'s Guests tab, renders inside): the wedding's own name (`<h1>`) and its
 * date/venue subtext. Kept separate from `WeddingGuestsPage`, which is explicitly scoped to the
 * Guests tab's own controls, not this shared page chrome.
 *
 * TS-53 (REQ-NON-FUNCTIONAL): `openTab` added as a generic, label-driven tab switch -- every one
 * of the 10 tab buttons (`WeddingDetailPage.tsx`'s own `TABS` array) shares the exact same
 * `getByRole("tab", {name: <label>, exact: true})` shape (TS-182: real tabs now, they were plain
 * buttons), already relied on identically by
 * every per-tab page object's own tab-button locator (`TablesTabPage.tablesTabButton`,
 * `RulesTabPage.rulesTabButton`, etc). Two tabs -- Activity and Collaborators -- have no dedicated
 * page object at all (see `getActivity`'s own doc comment in `e2e/data/api.ts`), so a generic
 * opener here is the only way to reach them through the real UI without inventing one-off page
 * objects for a single cross-cutting accessibility test. Waits for the network to go idle after
 * the click -- every tab's own mount effect fetches its data (confirmed the same shape as
 * `BudgetTabPage`/`TimelineTabPage`'s own documented double-fetch finding in `ActivityTab.tsx` and
 * `CollaboratorsTab.tsx`), so this avoids scanning a still-loading DOM.
 */

import type { Locator } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BasePage } from "./BasePage.js";
import { ConfirmDelete } from "../components/ConfirmDelete.js";

export class WeddingDetailPage extends BasePage {
  /** The page's own `<h1>` -- the wedding's name. A getter, not an assertion, so the test writes
   * its own `expect(...)` against it (this framework's established page-object pattern). */
  heading() {
    return this.page.getByRole("heading", { level: 1 });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
  }

  /** A tab's own level-2 heading (e.g. the Seating plan tab's "Seating plan") -- proof that tab is
   * the one showing. */
  tabHeading(text: string) {
    return this.page.getByRole("heading", { level: 2, name: text, exact: true });
  }

  /** TS-96: the "Getting started" step strip shown on a wedding with no plan yet. */
  gettingStarted() {
    return this.page.getByRole("region", { name: "Getting started" });
  }

  /** One step button in the strip, by its leading label (e.g. "2. Add tables"). Its accessible
   * name includes "(done)" once the step is complete. */
  gettingStartedStep(label: string) {
    // TS-200: every character with a meaning in a regular expression is escaped (backslash first,
    // so the escapes added here aren't escaped again) -- not just . ( and ).
    const escaped = label.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
    return this.gettingStarted().getByRole("button", { name: new RegExp(`^[✓○]?\\s*${escaped}`) });
  }

  /** TS-115: the tab row's vertical position (its first tab's top edge), for checking nothing
   * above it -- e.g. the Getting started strip -- pops in afterwards and pushes it down. */
  async tabRowTop(): Promise<number> {
    const guestsTab = this.page.getByRole("tab", { name: "Guests", exact: true });
    await guestsTab.waitFor();
    return (await guestsTab.boundingBox())!.y;
  }

  async waitForDataToSettle(): Promise<void> {
    await this.page.waitForLoadState("networkidle");
  }

  /** TS-93: the header's save-state indicator (SaveStatusIndicator) -- "Saving…", "All changes
   * saved", "Not saved: <why>", or "Offline — …". */
  saveStatus() {
    return this.page.getByRole("status", { name: "Save status" });
  }

  async dismissSaveError(): Promise<void> {
    await this.saveStatus().getByRole("button", { name: "Dismiss" }).click();
  }

  /** TS-109: the app-wide "Your session has expired" banner (SessionExpiredNotice, role="alert"). */
  sessionExpiredNotice() {
    return this.page.getByRole("alert").filter({ hasText: "Your session has expired" });
  }

  /** The notice's fallback link to the full /login page (with ?next= back here). TS-170: it opens
   * in a new tab, so this page keeps whatever was typed -- returns that tab. */
  async clickSignInAgain(): Promise<Page> {
    const [tab] = await Promise.all([
      this.page.context().waitForEvent("page"),
      this.page.getByRole("link", { name: "or use the sign-in page (opens a new tab)", exact: true }).click(),
    ]);
    return tab;
  }

  /** TS-94: signs back in from the notice itself, without leaving the page. */
  async signInFromSessionNotice(email: string, password: string): Promise<void> {
    const notice = this.sessionExpiredNotice();
    await notice.getByLabel("Email", { exact: true }).fill(email);
    await notice.getByLabel("Password", { exact: true }).fill(password);
    await notice.getByRole("button", { name: "Sign in here", exact: true }).click();
  }

  /** TS-116: the "Your access: Edit/Comment/View" badge a collaborator (never the owner) sees
   * beside the wedding's date. */
  yourAccessBadge() {
    return this.page.getByText(/^Your access: (Edit|Comment|View)$/);
  }

  /** TS-116 (FR-1.6): the non-blocking notice an open page shows once the owner changes this
   * user's access level (but doesn't remove it). */
  accessChangedNotice(level: "Owner" | "Edit" | "Comment" | "View") {
    return this.page.getByText(`Your access to this wedding was changed to ${level}.`, { exact: true });
  }

  /** FR-1.6's full-revocation message -- must only ever appear when access really was removed. */
  accessRemovedMessage() {
    // TS-214: worded for a deleted wedding as well as removed access (the page can't tell them apart).
    return this.page.getByText("This wedding is no longer available (it may have been deleted, or your access was removed).");
  }

  /** TS-136: any delete control on the page by its accessible name ("Remove Jane Smith",
   * "Revoke the invite for …", "Delete My template"), and the "Are you sure?" step it opens. */
  deleteTrigger(name: string | RegExp): Locator {
    return typeof name === "string" ? this.page.getByRole("button", { name, exact: true }) : this.page.getByRole("button", { name });
  }
  deleteConfirmation(): ConfirmDelete {
    return new ConfirmDelete(this.page);
  }

  /** Clicks the named tab button (its exact visible label, e.g. "Seating rules", "Day-of mode")
   * and waits for its own data fetch(es) to settle. */
  async openTab(label: string): Promise<void> {
    await this.page.getByRole("tab", { name: label, exact: true }).click();
    await this.page.waitForLoadState("networkidle");
  }

  /** TS-159: clicks a tab without waiting for it to open (it may be held by the unsaved-changes prompt). */
  async clickTab(label: string): Promise<void> {
    await this.page.getByRole("tab", { name: label, exact: true }).click();
  }
  /**
   * TS-176: the browser's Back button, once the page has put its Back guard in place -- it does so
   * just after the input changes, and pressing Back in the same instant (a few milliseconds, as a
   * test can) could beat it. A person can't type and press Back that fast.
   */
  async goBackWithUnsavedInput(): Promise<void> {
    await this.page.waitForFunction(() => window.history.state?.seatwiseGuard === true);
    await this.page.goBack();
  }
  /** TS-176: Back once the guard is gone again (after a save or a reload), for the same reason. */
  async goBackWithNothingUnsaved(): Promise<void> {
    await this.page.waitForFunction(() => window.history.state?.seatwiseGuard !== true);
    await this.page.goBack();
  }

  /** TS-159: the "you have unsaved changes on this tab" prompt. */
  unsavedChangesPrompt() {
    return this.page.getByRole("alertdialog").filter({ hasText: "You have unsaved changes on this tab" });
  }
  async stayOnTab(): Promise<void> {
    await this.unsavedChangesPrompt().getByRole("button", { name: "Stay on this tab", exact: true }).click();
  }
  async leaveTabWithoutSaving(): Promise<void> {
    await this.unsavedChangesPrompt().getByRole("button", { name: "Leave without saving", exact: true }).click();
  }

  /** TS-182: the row of tabs, one tab in it, and the panel showing the open tab. */
  tabList() {
    return this.page.getByRole("tablist", { name: "Wedding sections" });
  }
  tab(label: string) {
    return this.page.getByRole("tab", { name: label, exact: true });
  }
  tabPanel() {
    return this.page.getByRole("tabpanel");
  }
  /** TS-182: moves focus to a tab and presses a key there (e.g. ArrowRight to move along). */
  async pressOnTab(label: string, key: string): Promise<void> {
    await this.tab(label).focus();
    await this.tab(label).press(key);
  }

  /**
   * TS-182: closes the page the way closing the browser tab would, and returns the type of the
   * question the browser asked first ("beforeunload" when the page asks "Leave site?"), or null if
   * it closed without asking. The question is answered "stay", so the page is still open after.
   */
  async closeAndCatchLeaveQuestion(): Promise<string | null> {
    const asked = this.page
      .waitForEvent("dialog", { timeout: 5_000 })
      .then(async (dialog) => {
        const type = dialog.type();
        await dialog.dismiss();
        return type;
      })
      .catch(() => null);
    await this.page.close({ runBeforeUnload: true });
    return asked;
  }

  /**
   * TS-191: reloads the page the way the browser's reload button would, and returns the type of
   * the question the browser asked first ("beforeunload"), or null if it reloaded without asking.
   * The question is answered "leave", so the page has reloaded afterwards.
   */
  async reloadAndCatchLeaveQuestion(): Promise<string | null> {
    let asked: string | null = null;
    const onDialog = async (dialog: { type(): string; accept(): Promise<void> }) => {
      asked = dialog.type();
      await dialog.accept();
    };
    this.page.on("dialog", onDialog);
    try {
      await this.page.reload();
    } finally {
      this.page.off("dialog", onDialog);
    }
    return asked;
  }

  /** TS-191: whichever element has keyboard focus, for checking where focus went back to. */
  focusedElement() {
    return this.page.locator(":focus");
  }

  /** TS-166: the page's own "Back to dashboard" link. */
  backToDashboardLink() {
    return this.page.getByRole("link", { name: /Back to dashboard/ }).first();
  }
}
