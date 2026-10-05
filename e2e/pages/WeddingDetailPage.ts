/**
 * TS-37 — page object for the shared shell of `/weddings/:weddingId` (the page every tab, e.g.
 * `WeddingGuestsPage`'s Guests tab, renders inside): the wedding's own name (`<h1>`) and its
 * date/venue subtext. Kept separate from `WeddingGuestsPage`, which is explicitly scoped to the
 * Guests tab's own controls, not this shared page chrome.
 *
 * TS-53 (REQ-NON-FUNCTIONAL): `openTab` added as a generic, label-driven tab switch -- every one
 * of the 10 tab buttons (`WeddingDetailPage.tsx`'s own `TABS` array) shares the exact same
 * `getByRole("button", {name: <label>, exact: true})` shape, already relied on identically by
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
    return this.gettingStarted().getByRole("button", { name: new RegExp(`^[✓○]?\\s*${label.replace(/[.()]/g, "\\$&")}`) });
  }

  /** TS-115: the tab row's vertical position (its first tab's top edge), for checking nothing
   * above it -- e.g. the Getting started strip -- pops in afterwards and pushes it down. */
  async tabRowTop(): Promise<number> {
    const guestsTab = this.page.getByRole("button", { name: "Guests", exact: true });
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

  /** The notice's fallback link to the full /login page (with ?next= back here). */
  async clickSignInAgain(): Promise<void> {
    await this.page.getByRole("link", { name: "or use the sign-in page", exact: true }).click();
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
    return this.page.getByText("Your access to this wedding has been removed.");
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
    await this.page.getByRole("button", { name: label, exact: true }).click();
    await this.page.waitForLoadState("networkidle");
  }

  /** TS-159: clicks a tab without waiting for it to open (it may be held by the unsaved-changes prompt). */
  async clickTab(label: string): Promise<void> {
    await this.page.getByRole("button", { name: label, exact: true }).click();
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
}
