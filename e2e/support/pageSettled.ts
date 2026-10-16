/**
 * Review 14/15 — waiting for the wedding page to settle before loading another page (or the same one
 * again). After a save the page takes its extra Back-guard history entry off with a Back of its own;
 * a page load started just before that Back lands is cancelled on Chromium and Edge
 * (`net::ERR_ABORTED`), or hangs. A person can't reload within those few milliseconds; a test can.
 * Waits at most 2 s and never fails: with unsaved input the entry stays on purpose, and the page is
 * loaded anyway.
 */

import type { Page } from "@playwright/test";

export async function waitForPageToSettle(page: Page): Promise<void> {
  await page
    .waitForFunction(() => window.history.state?.seatwiseGuard !== true, undefined, { timeout: 2_000 })
    .catch(() => undefined);
}

/** Reloads the page once it has settled (see above). */
export async function reloadOnceSettled(page: Page): Promise<void> {
  await waitForPageToSettle(page);
  await page.reload();
}
