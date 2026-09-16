/**
 * TS-45 (REQ-DAY-OF-EMERGENCY-MODE) — page object for the wedding detail page's Day-of mode tab
 * (apps/web/src/app/weddings/[weddingId]/components/DayOfTab.tsx): a single phone-friendly view
 * for marking no-shows, adding walk-ins, and swapping two guests' tables, all without a full
 * regeneration. Selectors are kept private per the framework's raw-selector-in-test lint rule;
 * every control in this component already has a real accessible name (aria-label or button text)
 * confirmed directly against the component's source, so nothing here needs a raw data-testid.
 */

import { BasePage } from "./BasePage.js";

export class DayOfTabPage extends BasePage {
  private dayOfTabButton() {
    return this.page.getByRole("button", { name: "Day-of mode", exact: true });
  }

  private searchInput() {
    return this.page.getByLabel("Find a guest", { exact: true });
  }

  private guestRow(guestName: string) {
    return this.page.locator("li").filter({ has: this.page.getByText(guestName, { exact: true }) });
  }

  private attendanceButton(guestName: string) {
    return this.guestRow(guestName).getByRole("button", { name: /^mark (not attending|attending)$/i });
  }

  private seatAtSelect(guestName: string) {
    return this.guestRow(guestName).getByLabel(`Seat ${guestName} at a table`, { exact: true });
  }

  private walkInFirstNameInput() {
    return this.page.getByLabel("First name", { exact: true });
  }
  private walkInLastNameInput() {
    return this.page.getByLabel("Last name", { exact: true });
  }
  private walkInTableSelect() {
    return this.page.getByLabel("Seat the walk-in at a table", { exact: true });
  }
  private addWalkInButton() {
    return this.page.getByRole("button", { name: /^add walk-in$|^adding\.\.\.$/i });
  }

  private swapFirstGuestSelect() {
    return this.page.getByLabel("First guest to swap", { exact: true });
  }
  private swapSecondGuestSelect() {
    return this.page.getByLabel("Second guest to swap", { exact: true });
  }
  private swapButton() {
    return this.page.getByRole("button", { name: /^swap$|^swapping\.\.\.$/i });
  }

  /** The guest row's own status line -- "Not attending" / "Seated at {table}" / "Unassigned" --
   * confirmed directly in DayOfTab.tsx to be the row's second, dedicated `<p>`. A test asserts
   * against this rather than scanning the whole page for the status text, since "Not attending"
   * or a table label could otherwise coincidentally appear elsewhere on the page. */
  guestStatusText(guestName: string) {
    return this.guestRow(guestName).locator("p").nth(1);
  }

  // TS-45 (AC-063): public locator accessors for the touch-target size test -- this framework's
  // established pattern (see BasePage's own `textLocator`) is a page object exposing a `Locator`
  // for the *test* to assert against (here, a bounding-box height), rather than embedding the
  // assertion itself.
  searchInputLocator() {
    return this.searchInput();
  }
  attendanceButtonLocator(guestName: string) {
    return this.attendanceButton(guestName);
  }
  addWalkInButtonLocator() {
    return this.addWalkInButton();
  }
  swapButtonLocator() {
    return this.swapButton();
  }

  noticeText() {
    return this.page.locator("p.text-blue-800, p.text-blue-300");
  }

  errorText() {
    return this.page.locator("p.text-red-600, p.text-red-400");
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
    await this.dayOfTabButton().click();
  }

  async search(query: string): Promise<void> {
    await this.searchInput().fill(query);
  }

  /** TS-66: waits for the guest's attendance button to settle on its new resting label before
   * returning -- previously this just clicked and returned, which let a caller's very next
   * assertion (real-UI or, worse, a direct API read) race the click against the attendance
   * mutation + re-render still in flight. This raced intermittently in Firefox. Mirrors the same
   * "wait for the button's resting state" pattern this page object's own addWalkIn()/swap()
   * already use for their submit buttons. */
  async toggleAttendance(guestName: string): Promise<void> {
    const button = this.attendanceButton(guestName);
    // The button's label names the action it offers, i.e. the *opposite* of the guest's current
    // state -- "Mark not attending" means the guest is currently attending, and vice versa.
    const guestCurrentlyAttending = /not attending/i.test((await button.textContent()) ?? "");
    await button.click();
    const newLabel = guestCurrentlyAttending ? /^mark attending$/i : /^mark not attending$/i;
    await this.guestRow(guestName).getByRole("button", { name: newLabel }).waitFor();
  }

  async seatGuestAt(guestName: string, tableLabel: string): Promise<void> {
    await this.seatAtSelect(guestName).selectOption({ label: tableLabel });
  }

  async addWalkIn(firstName: string, lastName: string, tableLabel?: string): Promise<void> {
    await this.walkInFirstNameInput().fill(firstName);
    await this.walkInLastNameInput().fill(lastName);
    if (tableLabel) {
      await this.walkInTableSelect().selectOption({ label: tableLabel });
    }
    await this.addWalkInButton().click();
    await this.page.getByRole("button", { name: "Add walk-in", exact: true }).waitFor();
  }

  async swap(firstGuestOption: string, secondGuestOption: string): Promise<void> {
    await this.swapFirstGuestSelect().selectOption({ label: firstGuestOption });
    await this.swapSecondGuestSelect().selectOption({ label: secondGuestOption });
    await this.swapButton().click();
    await this.page.getByRole("button", { name: "Swap", exact: true }).waitFor();
  }

  /** TS-45 (AC-063): the set of controls FR-8.4 requires to be thumb-sized -- confirmed directly
   * in the component's source to each carry Tailwind's `min-h-11` (44px) class: the search input,
   * every rendered "Mark (not) attending" button, the "Add walk-in" button, and (once at least two
   * guests are seated) the "Swap" button. Returned as one combined locator so a test can assert a
   * minimum bounding-box height across all of them in one pass rather than one assertion per
   * control. */
  touchTargets() {
    return this.page.locator(
      "#dayof-guest-search, li button, form button[type=submit], button:has-text('Swap')",
    );
  }
}
