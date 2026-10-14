/**
 * Review 14 — plays a slow or busy device for the wedding page's own history Back. After a save the
 * page takes its extra Back-guard entry off history with `history.back()`; on a slow device that
 * Back lands late, after things the planner pressed next (Log out). This makes every
 * `history.back()` the page itself calls land `ms` later, so that timing is reproduced every run
 * instead of once in hundreds. Only affects the page it's installed on, from its next load.
 */

import type { Page } from "@playwright/test";

export async function delayPagesOwnBack(page: Page, ms: number): Promise<void> {
  await page.addInitScript((delay) => {
    const back = history.back.bind(history);
    history.back = () => void window.setTimeout(back, delay);
  }, ms);
}
