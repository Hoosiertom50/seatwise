/**
 * TS-42 — component object for one seating-rule row on the Seating rules tab (RulesTab.tsx).
 * Receives its root `Locator` through the constructor (same pattern as GuestRow), so it holds no
 * mutable browser state of its own.
 *
 * There is no per-field aria-label convention here (unlike GuestRow) -- a rule row is read-only
 * prose (`{guestAName} & {guestBName}` plus the type's label), with only a Remove button as an
 * interactive element. Seating rules have no "edit" verb at all (confirmed directly against
 * RulesTab.tsx's own comment: "Seating rules have no 'edit' verb (only add/remove)") -- AC-029's
 * literal wording ("can be edited or removed from that screen") is only half-true; this component
 * intentionally exposes no edit affordance because the app has none.
 */

import { type Locator } from "@playwright/test";
import { ConfirmDelete } from "./ConfirmDelete.js";

export class RuleRow {
  constructor(private readonly root: Locator) {}

  locator(): Locator {
    return this.root;
  }

  // TS-136: the trigger is named "Remove <who/what>", and opens the "Are you sure?" step.
  private removeButton() {
    return this.root.getByRole("button", { name: /^Remove / });
  }

  /** TS-136: clicks Remove without answering, leaving the "Are you sure?" question open. */
  async startRemove(): Promise<void> {
    await this.removeButton().click();
  }

  /** TS-136: the "Are you sure?" step for this row. */
  removeConfirmation(): ConfirmDelete {
    return new ConfirmDelete(this.root);
  }

  /** Removes the rule, answering "Yes" to the TS-136 question. */
  async remove(): Promise<void> {
    await this.removeButton().click();
    await this.removeConfirmation().confirm();
  }
}
