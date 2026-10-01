/**
 * TS-136 — component object for the app's shared "Are you sure?" step (ConfirmDeleteButton.tsx).
 * Every permanent delete in the app now asks first: the trigger opens an inline alertdialog with a
 * red "Yes, …" button that goes ahead and a Cancel button that changes nothing. Scoped to the row
 * (or other container) the trigger lives in, so several open rows never collide.
 */

import type { Locator, Page } from "@playwright/test";

export class ConfirmDelete {
  constructor(private readonly scope: Locator | Page) {}

  /** The open question itself (its text says what will be deleted). */
  question(): Locator {
    return this.scope.getByRole("alertdialog");
  }

  async confirm(): Promise<void> {
    await this.question().getByRole("button", { name: /^Yes, / }).click();
  }

  /** The Cancel button -- it takes focus when the question opens, so a stray Enter never deletes. */
  cancelButton(): Locator {
    return this.question().getByRole("button", { name: "Cancel", exact: true });
  }

  async cancel(): Promise<void> {
    await this.question().getByRole("button", { name: "Cancel", exact: true }).click();
  }
}
