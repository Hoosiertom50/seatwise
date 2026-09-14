/**
 * TS-37 — page object for the shared shell of `/weddings/:weddingId` (the page every tab, e.g.
 * `WeddingGuestsPage`'s Guests tab, renders inside): the wedding's own name (`<h1>`) and its
 * date/venue subtext. Kept separate from `WeddingGuestsPage`, which is explicitly scoped to the
 * Guests tab's own controls, not this shared page chrome.
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
}
