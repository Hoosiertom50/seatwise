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
   * Real finding #1, empirically confirmed (a standalone Playwright script hitting the live dev
   * server directly): clicking either attending/declining toggle button occasionally has no effect
   * at all -- the button itself receives the click (Playwright never reports an actionability
   * failure) but the resulting `setAttending(...)` re-render never happens, and simply waiting
   * longer afterward doesn't help either (confirmed by polling for 2s after a swallowed click with
   * zero retries -- it never recovers on its own). This shows up only right after a fresh full-page
   * load (never on a second click within the same already-interactive page), so it's consistent
   * with a brief window where the DOM has painted but the page isn't fully interactive yet -- and
   * how long that window lasts scales with how busy the machine is: isolated runs recovered within
   * 1-2 retries (a few hundred ms), but the same race under a full, CPU-contended regression-suite
   * run needed several seconds.
   *
   * Real finding #2, also empirically confirmed (a second standalone script, this one logging
   * every request/response for `/api/v1/rsvp/:token`): this page's own `useEffect(() => { load()
   * }, [token])` fires its GET twice on every mount (React Strict Mode double-invokes effects in
   * dev -- `next dev` never opts out of Strict Mode), and `load()`'s `.then` unconditionally calls
   * `setAttending(res.rsvp.rsvpStatus === "DECLINED" ? "DECLINED" : "CONFIRMED")` with whatever was
   * on the server, with no guard against a click that has already happened in the meantime. On a
   * *revisit* to an already-CONFIRMED link (never on a fresh guest's first visit -- there the
   * fetched value already matches the CONFIRMED default, so a stale second response has nothing to
   * clobber), clicking "Regretfully declining" in between the two GETs' responses -- or even just
   * before the slower of the two lands -- gets silently reverted back to CONFIRMED moments later
   * when that second, stale response's `setAttending("CONFIRMED")` runs. Confirmed directly: the
   * decline click can register *instantly* (`headcountInput` gone right after the click) and still
   * revert within a few hundred ms with no further interaction from the test at all. This is
   * consistent with the double-fetch being a `next dev`/Strict-Mode-only artifact (effects run
   * once in a production build), but this whole framework only ever runs against `next dev`, so
   * it's a real, reproducible race in the actual environment under test, not a theoretical one.
   *
   * Both races share the same fix shape -- a click-and-verify retry bounded by a wall-clock
   * deadline, not a fixed attempt count or a longer fixed wait (a genuinely swallowed click never
   * un-swallows itself by waiting, and a raised *test* timeout would still stay a small fraction of
   * the per-test budget even in the slow case) -- but finding #2 means a single instantaneous match
   * right after the click is not trustworthy on its own: the match itself has to be re-confirmed
   * after a short settle window before this method trusts it, or the very race this method exists
   * to defeat would silently slip back in right as it returns.
   */
  private async setAttending(attending: "CONFIRMED" | "DECLINED"): Promise<void> {
    const button = attending === "CONFIRMED" ? this.attendingButton() : this.decliningButton();
    const confirmedFieldsExpected = attending === "CONFIRMED";
    const deadline = Date.now() + 15_000;
    const matchesExpected = async () => (await this.headcountInput().count()) > 0 === confirmedFieldsExpected;
    let lastConfirmedFieldsPresent: boolean | undefined;
    while (Date.now() < deadline) {
      await button.click();
      lastConfirmedFieldsPresent = (await this.headcountInput().count()) > 0;
      if (lastConfirmedFieldsPresent === confirmedFieldsExpected) {
        // Finding #2: don't trust an instantaneous match -- a stale double-fetch response can
        // still be in flight and clobber it moments later. Re-check after a settle window (well
        // past the ~100ms the diagnostic script observed the revert land in) before returning; if
        // it reverted, loop back around and click again, still bounded by the same deadline.
        await this.page.waitForTimeout(500);
        if (await matchesExpected()) {
          return;
        }
        continue;
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error(
      `GuestRsvpPage: clicking the ${attending} toggle never took effect (and held) within 15s ` +
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
