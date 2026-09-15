/**
 * TS-42 — page object for the wedding-detail page's "Seating rules" tab (RulesTab.tsx). Note the
 * tab's visible label is "Seating rules", not "Rules" (see the `TABS` array in
 * apps/web/src/app/weddings/[weddingId]/page.tsx).
 */

import { BasePage } from "./BasePage.js";
import { RuleRow } from "../components/RuleRow.js";

export type RuleType = "MUST_SIT_TOGETHER" | "MUST_NOT_SIT_TOGETHER" | "PREFER_NEAR" | "AVOID";

export class RulesTabPage extends BasePage {
  private rulesTabButton() {
    return this.page.getByRole("button", { name: "Seating rules", exact: true });
  }

  private guestASelect() {
    return this.page.locator("#rule-guest-a");
  }

  private guestBSelect() {
    return this.page.locator("#rule-guest-b");
  }

  private ruleTypeSelect() {
    return this.page.locator("#rule-type");
  }

  private addRuleButton() {
    return this.page.getByRole("button", { name: /^add rule$|^adding\.\.\.$/i });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
  }

  async openRulesTab(): Promise<void> {
    await this.rulesTabButton().click();
  }

  /** Fills and submits the add-rule form by each guest's full name (matching the option text the
   * app renders: `{firstName} {lastName}`) and the rule type. Waits for the POST to resolve before
   * returning -- TS-55 real finding: RulesTab.tsx resets both guest `<select>`s back to their
   * placeholder option on a successful submit (`setGuestAId("")`/`setGuestBId("")`), and without
   * this wait, calling `addRule` a second time races that reset -- the second call's own
   * `selectOption`s can land, then get silently wiped by the first submission's still-in-flight
   * response resolving a moment later, leaving the form on its placeholder options when "Add rule"
   * is clicked (a real, empirically-observed failure: this method had never been called twice in
   * one test before this story). */
  async addRule(guestAFullName: string, guestBFullName: string, type: RuleType): Promise<void> {
    await this.guestASelect().selectOption({ label: guestAFullName });
    await this.guestBSelect().selectOption({ label: guestBFullName });
    await this.ruleTypeSelect().selectOption(type);
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "POST" && /\/relationships$/.test(new URL(res.url()).pathname),
      ),
      this.addRuleButton().click(),
    ]);
  }

  /** The "Rules (N)" list heading, whose count updates live as rules are added/removed. */
  rulesHeading(count: number) {
    return this.page.getByText(`Rules (${count})`, { exact: true });
  }

  /** Returns a RuleRow scoped to the row naming both guests (in either order, since the app
   * always renders "{guestAName} & {guestBName}" in the order the rule was created with, not
   * necessarily the order a caller happens to think of the pair). */
  ruleRow(guestAFullName: string, guestBFullName: string): RuleRow {
    const row = this.page
      .locator("li")
      .filter({ hasText: `${guestAFullName} & ${guestBFullName}` })
      .or(this.page.locator("li").filter({ hasText: `${guestBFullName} & ${guestAFullName}` }));
    return new RuleRow(row);
  }
}
