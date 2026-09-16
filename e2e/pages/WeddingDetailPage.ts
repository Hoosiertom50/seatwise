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

import { BasePage } from "./BasePage.js";

export class WeddingDetailPage extends BasePage {
  /** The page's own `<h1>` -- the wedding's name. A getter, not an assertion, so the test writes
   * its own `expect(...)` against it (this framework's established page-object pattern). */
  heading() {
    return this.page.getByRole("heading", { level: 1 });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
  }

  /** Clicks the named tab button (its exact visible label, e.g. "Seating rules", "Day-of mode")
   * and waits for its own data fetch(es) to settle. */
  async openTab(label: string): Promise<void> {
    // TS-62 SPIKE (DO NOT MERGE): see BasePage.waitForSettled.
    await this.waitForSettled();
    await this.page.getByRole("button", { name: label, exact: true }).click();
    await this.page.waitForLoadState("networkidle");
  }
}
