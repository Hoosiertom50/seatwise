/**
 * TS-50 (REQ-CLIENT-RSVP-COLLECTION) — page object for the guest's own, fully unauthenticated
 * RSVP page at `/rsvp/[token]` (apps/web/src/app/rsvp/[token]/page.tsx). No sign-in of any kind is
 * involved -- a test drives this page from a fresh `browser.newContext()` with an empty cookie
 * jar (see e2e/support/auth.ts's `signUpFreshAccountInNewContext` for the established pattern of a
 * separately-authenticated actor; here there's no auth step at all, just a fresh, cookie-free
 * context proving the page needs none). Every field except the two attending-toggle buttons is a
 * `<label>` wrapping its own `<input>`/`<textarea>` with no `id`, so `getByLabel` (implicit label
 * association) is used throughout rather than an invented attribute.
 */

import { BasePage } from "./BasePage.js";

export class GuestRsvpPage extends BasePage {
  private attendingButton() {
    return this.page.getByRole("button", { name: "Joyfully attending", exact: true });
  }
  private decliningButton() {
    return this.page.getByRole("button", { name: "Regretfully declining", exact: true });
  }
  private headcountInput() {
    return this.page.getByLabel("Total in your party (including you)", { exact: true });
  }
  private plusOneNamesInput() {
    return this.page.getByLabel("Who's coming with you?", { exact: true });
  }
  private accessibleTableCheckbox() {
    return this.page.getByLabel("I (or someone in my party) need an accessible seat", { exact: true });
  }
  /**
   * Real finding, empirically confirmed (a standalone Playwright script against the live dev
   * server, reproduced 100% of the time once the textarea already has a value): this field's
   * `<label>` wraps both its caption `<span>` and the `<textarea>` itself, and a textarea's
   * current value is rendered as literal child text content in the DOM (that's how React keeps a
   * controlled textarea's native uncontrolled-value behavior in sync). The browser's accessible-name
   * computation for the wrapping `<label>` concatenates ALL of its descendant text, so once the
   * textarea holds a value the computed name becomes
   * "Dietary restrictions or anything else we should know" + that value glued on with no separator
   * (e.g. "...should knowVegetarian, please."), never the caption text alone -- so `exact: true`
   * only ever matches while the field is still empty, and permanently stops matching (an
   * indefinitely-retrying, silently-failing `getByLabel`) the moment it has prior content, exactly
   * the situation a second visit to an already-answered RSVP link produces. `exact: false` (a
   * "contains" match) is the correct, deliberate choice here, not a loosened assertion -- the
   * caption text is always a leading substring of the computed name regardless of the textarea's
   * value. (The other fields on this form are plain `<input>` elements, which render no child text
   * content at all, so their wrapping labels never exhibit this and keep using `exact: true`.)
   */
  private notesInput() {
    return this.page.getByLabel("Dietary restrictions or anything else we should know", { exact: false });
  }
  private submitButton() {
    return this.page.getByRole("button", { name: /^submit rsvp$|^submitting\.\.\.$/i });
  }

  async goto(token: string): Promise<void> {
    await this.page.goto(`/rsvp/${token}`);
  }

  heading() {
    return this.page.locator("h1");
  }

  notFoundMessage() {
    return this.page.getByText("This RSVP link doesn't exist.", { exact: true });
  }

  closedMessage() {
    return this.page.getByText(/^RSVP responses have closed/);
  }

  successBanner() {
    return this.page.getByText(
      "Thanks — your RSVP has been recorded. You can come back to this link any time to update it.",
      { exact: true },
    );
  }

  /** Whether the whole form is disabled -- true once RSVP responses have closed (the enclosing
   * `<fieldset disabled>`), checked against the headcount input as a representative field rather
   * than every single one. */
  async isFormDisabled(): Promise<boolean> {
    return this.headcountInput().isDisabled();
  }

  /**
   * Real finding, empirically confirmed (a standalone Playwright script hitting the live dev
   * server directly): clicking either attending/declining toggle button occasionally has no effect
   * at all -- the button itself receives the click (Playwright never reports an actionability
   * failure) but the resulting `setAttending(...)` re-render never happens, and simply waiting
   * longer afterward doesn't help either (confirmed by polling for 2s after a swallowed click with
   * zero retries -- it never recovers on its own). This shows up only right after a fresh full-page
   * load (never on a second click within the same already-interactive page), so it's consistent
   * with a brief window where the DOM has painted but the page isn't fully interactive yet -- and
   * how long that window lasts scales with how busy the machine is: isolated runs recovered within
   * 1-2 retries (a few hundred ms), but the same race under a full, CPU-contended regression-suite
   * run needed several seconds. A click-and-verify retry bounded by a wall-clock deadline (not a
   * fixed attempt count) is the correct fix -- not a longer fixed wait, since a genuinely swallowed
   * click never becomes un-swallowed by waiting on its own, and not a raised *test* timeout, since
   * this stays a small fraction of the per-test budget even in the slow case.
   */
  private async setAttending(attending: "CONFIRMED" | "DECLINED"): Promise<void> {
    const button = attending === "CONFIRMED" ? this.attendingButton() : this.decliningButton();
    const confirmedFieldsExpected = attending === "CONFIRMED";
    const deadline = Date.now() + 15_000;
    let lastConfirmedFieldsPresent: boolean | undefined;
    while (Date.now() < deadline) {
      await button.click();
      lastConfirmedFieldsPresent = (await this.headcountInput().count()) > 0;
      if (lastConfirmedFieldsPresent === confirmedFieldsExpected) {
        return;
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error(
      `GuestRsvpPage: clicking the ${attending} toggle never took effect within 15s ` +
        `(last observed confirmedFieldsPresent=${lastConfirmedFieldsPresent}).`,
    );
  }

  /** Fills and submits the form. `attending: "DECLINED"` skips every CONFIRMED-only field (they're
   * not rendered at all once declining is selected), matching the real form's own conditional
   * rendering rather than trying to fill fields that don't exist. */
  async submit(input: {
    attending: "CONFIRMED" | "DECLINED";
    headcount?: number;
    plusOneNames?: string;
    requiresAccessibleTable?: boolean;
    notes?: string;
  }): Promise<void> {
    await this.setAttending(input.attending);
    if (input.attending === "CONFIRMED") {
      if (input.headcount !== undefined) {
        await this.headcountInput().fill(String(input.headcount));
      }
      if (input.plusOneNames !== undefined) {
        await this.plusOneNamesInput().fill(input.plusOneNames);
      }
      if (input.requiresAccessibleTable) {
        await this.accessibleTableCheckbox().check();
      }
    }
    if (input.notes !== undefined) {
      await this.notesInput().fill(input.notes);
    }
    await Promise.all([
      this.page.waitForResponse(
        (res) => res.request().method() === "POST" && /\/api\/v1\/rsvp\/[^/]+$/.test(new URL(res.url()).pathname),
      ),
      this.submitButton().click(),
    ]);
  }
}
