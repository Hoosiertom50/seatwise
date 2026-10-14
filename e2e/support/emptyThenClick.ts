// PR #115 review: emptying a box that counted as unsaved starts the page's own Back (taking its extra
// history entry off), and a link followed before that Back landed was cancelled by it. A person
// can't click that fast, so this does both in the same moment, inside the page.

import type { Locator } from "@playwright/test";

/** Empties `box` (as typing would) and clicks `target` straight after, in the same task. */
export async function emptyThenClickAtOnce(box: Locator, target: Locator): Promise<void> {
  const link = await target.elementHandle();
  await box.evaluate((el, a) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    (a as HTMLElement).click();
  }, link);
}
