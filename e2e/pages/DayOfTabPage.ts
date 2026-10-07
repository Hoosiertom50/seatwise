/**
 * TS-45 (REQ-DAY-OF-EMERGENCY-MODE) — page object for the wedding detail page's Day-of mode tab
 * (apps/web/src/app/weddings/[weddingId]/components/DayOfTab.tsx): a single phone-friendly view
 * for marking no-shows, adding walk-ins, and swapping two guests' tables, all without a full
 * regeneration. Selectors are kept private per the framework's raw-selector-in-test lint rule;
 * every control in this component already has a real accessible name (aria-label or button text)
 * confirmed directly against the component's source, so nothing here needs a raw data-testid.
 */

import type { Locator } from "@playwright/test";
import { BasePage } from "./BasePage.js";

export class DayOfTabPage extends BasePage {
  private dayOfTabButton() {
    return this.page.getByRole("tab", { name: "Day-of mode", exact: true });
  }

  private searchInput() {
    return this.page.getByLabel("Find a guest", { exact: true });
  }

  private guestRow(guestName: string) {
    return this.page.locator("li").filter({ has: this.page.getByText(guestName, { exact: true }) });
  }

  private attendanceButton(guestName: string) {
    // TS-212: the button's name ends with the guest's name ("Mark not attending: Jane Smith").
    return this.guestRow(guestName).getByRole("button", { name: /^mark (not attending|attending)\b/i });
  }

  private seatAtSelect(guestName: string) {
    return this.guestRow(guestName).getByLabel(`Seat ${guestName} at a table`, { exact: true });
  }

  /** TS-191: a seated guest's "Move to…" list -- only tables with enough free seats are offered,
   * each as "<label> (<n> free)". */
  private moveToSelect(guestName: string) {
    return this.guestRow(guestName).getByLabel(`Move ${guestName} to another table`, { exact: true });
  }

  /** TS-191: the table labels offered in a seated guest's "Move to…" list. */
  async moveToChoices(guestName: string): Promise<string[]> {
    const options = await this.moveToSelect(guestName).locator("option:not([disabled])").allTextContents();
    return options.map((o) => o.replace(/ \(\d+ free\)$/, ""));
  }

  /** TS-191: moves a seated guest to another table and waits until their row says they're there. */
  async moveGuestTo(guestName: string, tableLabel: string): Promise<void> {
    const select = this.moveToSelect(guestName);
    const options = await select.locator("option").allTextContents();
    const option = options.find((o) => o.startsWith(`${tableLabel} (`));
    if (!option) throw new Error(`DayOfTabPage.moveGuestTo: ${tableLabel} isn't offered (have: ${options.join(" | ")})`);
    await select.selectOption({ label: option });
    // TS-199: choosing only picks the table; the Move button next to the list makes the move.
    await this.moveButton(guestName).click();
    await this.guestStatusText(guestName).filter({ hasText: `Seated at ${tableLabel}` }).waitFor();
  }

  /** TS-197: picks a table in a seated guest's "Move to…" list without waiting for the guest to be
   * there -- for a move the server is expected to refuse (the row then shows why). */
  async startMoveGuestTo(guestName: string, tableLabel: string): Promise<void> {
    const select = this.moveToSelect(guestName);
    const options = await select.locator("option").allTextContents();
    const option = options.find((o) => o.startsWith(`${tableLabel} (`));
    if (!option) throw new Error(`DayOfTabPage.startMoveGuestTo: ${tableLabel} isn't offered (have: ${options.join(" | ")})`);
    await select.selectOption({ label: option });
    // TS-199: picking only chooses the table -- the Move button sends it.
    await this.moveButton(guestName).click();
  }

  /** TS-197: the message in a guest's own row (e.g. why a move wasn't saved). */
  guestRowError(guestName: string) {
    return this.guestRow(guestName).getByRole("alert");
  }

  /** TS-197: shown when Day-of switches to a plan made since it opened. */
  newerPlanNotice() {
    return this.page.getByRole("status").filter({ hasText: "A newer plan was made — you're now looking at it." });
  }

  /** TS-199: the button that makes the move once a table is picked in the "Move to…" list. */
  moveButton(guestName: string) {
    return this.guestRow(guestName).getByRole("button", { name: `Move ${guestName}`, exact: true });
  }

  /** TS-199: the button that seats an unseated guest once a table is picked in "Seat at…". */
  seatButton(guestName: string) {
    return this.guestRow(guestName).getByRole("button", { name: `Seat ${guestName}`, exact: true });
  }

  /** TS-199: focuses a seated guest's "Move to…" list and presses the down arrow `times` times,
   * the way a keyboard user looks through the tables -- nothing should move until Move. */
  async arrowThroughMoveChoices(guestName: string, times: number): Promise<void> {
    await this.moveToSelect(guestName).focus();
    for (let i = 0; i < times; i++) await this.page.keyboard.press("ArrowDown");
  }

  /** TS-199: the table label (without "(n free)") picked in a seated guest's "Move to…" list, or
   * "" when none is picked. */
  async pickedMoveChoice(guestName: string): Promise<string> {
    const select = this.moveToSelect(guestName);
    const value = await select.inputValue();
    if (!value) return "";
    const text = await select.locator(`option[value="${value}"]`).textContent();
    return (text ?? "").replace(/ \(\d+ free\)$/, "");
  }

  /** TS-199: whether a seated guest's "Move to…" list has focus. */
  moveToList(guestName: string) {
    return this.moveToSelect(guestName);
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

  /** TS-118: the message shown before any seating plan exists. */
  noPlanMessage() {
    return this.page.getByText(/^No seating plan generated yet/);
  }

  /** TS-118: one table's card in the occupancy strip, e.g. "Alpha" + "2/2 seated". */
  occupancyCard(tableLabel: string) {
    return this.page
      .locator("div")
      .filter({ has: this.page.getByText("Table occupancy", { exact: true }) })
      .locator("div.shrink-0")
      .filter({ has: this.page.getByText(tableLabel, { exact: true }) });
  }

  /** TS-118: the guests the list is currently showing (after any search). */
  visibleGuestRows() {
    return this.page.locator("ul > li");
  }

  /** TS-118: a guest's row, for visibility checks after a search. */
  guestRowLocator(guestName: string) {
    return this.guestRow(guestName);
  }

  /** TS-118: the "No guests match …" line a search with no results shows. */
  noSearchMatchMessage() {
    return this.page.getByText(/^No guests match/);
  }

  /** TS-208: what a wedding with no guests says (it read 'No guests match “”.'). */
  noGuestsYetMessage() {
    return this.page.getByText("No guests yet.", { exact: true });
  }

  /** TS-118: the Swap panel -- only offered once a plan has at least two seated guests. */
  swapPanel() {
    return this.page.getByText("Swap two guests' tables", { exact: true });
  }

  noticeText() {
    return this.page.locator("p.text-blue-800, p.text-blue-300");
  }

  // TS-118: a full table's "N/N seated" in the occupancy strip is red too -- not an error.
  errorText() {
    return this.page.locator("p.text-red-600, p.text-red-400").filter({ hasNotText: /^\d+\/\d+ seated$/ });
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
    const newLabel = guestCurrentlyAttending ? /^mark attending\b/i : /^mark not attending\b/i;
    await this.guestRow(guestName).getByRole("button", { name: newLabel }).waitFor();
  }

  /** TS-208: picks "<label> (<n> free)" in a list whose options carry free-seat counts. */
  private async pickTable(select: Locator, tableLabel: string, what: string): Promise<void> {
    const options = await select.locator("option").allTextContents();
    const option = options.find((o) => o.startsWith(`${tableLabel} (`));
    if (!option) throw new Error(`DayOfTabPage.${what}: ${tableLabel} isn't offered (have: ${options.join(" | ")})`);
    await select.selectOption({ label: option });
  }

  async seatGuestAt(guestName: string, tableLabel: string): Promise<void> {
    // TS-208: the list now offers only tables the guest fits at, each as "<label> (<n> free)".
    await this.pickTable(this.seatAtSelect(guestName), tableLabel, "seatGuestAt");
    // TS-199: choosing only picks the table; the Seat button seats them.
    await this.seatButton(guestName).click();
  }

  /** TS-202: the walk-in's party size box (1 unless changed). */
  walkInPartySizeInput() {
    return this.page.getByLabel("Party size", { exact: true });
  }

  /** TS-208: the table labels offered in an unseated guest's "Seat at…" list. */
  async seatAtChoices(guestName: string): Promise<string[]> {
    const options = await this.seatAtSelect(guestName).locator("option:not([disabled])").allTextContents();
    return options.map((o) => o.replace(/ \(\d+ free\)$/, ""));
  }

  /** TS-208: the table labels offered in the walk-in form's "Seat at…" list. */
  async walkInChoices(): Promise<string[]> {
    const options = await this.walkInTableSelect().locator("option").allTextContents();
    return options.slice(1).map((o) => o.replace(/ \(\d+ free\)$/, ""));
  }

  /** TS-208: a guest's "Mark (not) attending" button -- where focus goes when their list is off. */
  attendanceButtonOf(guestName: string) {
    return this.attendanceButton(guestName);
  }

  async addWalkIn(firstName: string, lastName: string, tableLabel?: string, partySize?: number): Promise<void> {
    await this.walkInFirstNameInput().fill(firstName);
    await this.walkInLastNameInput().fill(lastName);
    if (partySize !== undefined) await this.walkInPartySizeInput().fill(String(partySize));
    if (tableLabel) {
      // TS-208: offered as "<label> (<n> free)", like the other lists.
      await this.pickTable(this.walkInTableSelect(), tableLabel, "addWalkIn");
    }
    await this.addWalkInButton().click();
    await this.page.getByRole("button", { name: "Add walk-in", exact: true }).waitFor();
  }

  /** TS-151: what the walk-in first-name box holds (empty once the guest has been added). */
  async walkInFirstNameValue(): Promise<string> {
    return this.walkInFirstNameInput().inputValue();
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
