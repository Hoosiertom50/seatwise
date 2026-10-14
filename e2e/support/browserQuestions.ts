/**
 * Review 15 — records the browser's own questions ("Leave site?", alerts) on one page, answering
 * each with "stay"/cancel, so a test can assert none was asked. Without a listener Playwright
 * answers them silently and the test never learns the browser asked -- which is how Log out after
 * "Leave without saving" came to ask "Leave site?" as well, unnoticed.
 */

import type { Dialog, Page } from "@playwright/test";

export interface BrowserQuestions {
  /** The type of each question asked so far ("beforeunload", "confirm", ...). */
  readonly asked: readonly string[];
  stop(): void;
}

export function watchBrowserQuestions(page: Page): BrowserQuestions {
  const asked: string[] = [];
  const onDialog = (dialog: Dialog) => {
    asked.push(dialog.type());
    void dialog.dismiss().catch(() => undefined);
  };
  page.on("dialog", onDialog);
  return { asked, stop: () => page.off("dialog", onDialog) };
}
