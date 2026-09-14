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

export class RuleRow {
  constructor(private readonly root: Locator) {}

  locator(): Locator {
    return this.root;
  }

  private removeButton() {
    return this.root.getByRole("button", { name: "Remove" });
  }

  async remove(): Promise<void> {
    await this.removeButton().click();
  }
}
