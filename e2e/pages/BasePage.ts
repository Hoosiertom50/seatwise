/**
 * Stage 03 — base page-object pattern (spec Section 7.2 / Stage 03 tasks).
 *
 * Every page object receives its `Page` through the constructor (never reads a module-level or
 * static `page` reference), so it holds no global mutable browser state and is safe to construct
 * fresh per test/fixture without any cross-test leakage. Subclasses expose business-readable
 * operations (`login(...)`, `addGuest(...)`) rather than raw selector/click sequences — selectors
 * themselves stay private to the page object per spec Section 7.2's centralization rule.
 *
 * TS-37: `textLocator` lives here rather than on any one subclass — "is this plain text
 * visible/gone somewhere on the current page" is a cross-cutting need several page objects have (a
 * wedding's own name absent from another wedding's page, a "No date set" placeholder gone after
 * saving a date, a "Signed in as ..." greeting), not a business operation specific to any single
 * page. It returns a `Locator`, not an assertion, matching this framework's established pattern
 * (see `GuestRow`'s getters) of page/component objects exposing locators/values for the *test* to
 * assert against, rather than embedding the assertion itself.
 *
 * TS-38: accepts a `RegExp` as well as a plain string, for cases where a test needs to match text
 * whose exact substring isn't fixed by any documented contract -- e.g. a conflict message naming
 * two guests in an order the seating engine doesn't promise (confirmed by a real run: the same
 * transitive-contradiction scenario named the pair in the opposite order from an earlier run). The
 * `exact` option only applies to a plain-string match; a `RegExp` is passed through to `getByText`
 * as-is, matching Playwright's own overload.
 */

import type { Locator, Page } from "@playwright/test";

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  textLocator(text: string | RegExp, exact = false): Locator {
    return typeof text === "string" ? this.page.getByText(text, { exact }) : this.page.getByText(text);
  }

  // TS-62 SPIKE (DO NOT MERGE): candidate fix for the WebKit-only failure pattern found in TS-60's
  // spike (13 failures, every one on the very first interaction after a fresh page load or tab
  // switch). Working hypothesis (see the TS-62 Jira comment): WebKit's paint/hydration timing
  // differs enough from Chromium/Firefox that a click can land before React has finished binding
  // its event handlers -- the same shape as the open, unresolved microsoft/playwright#27759.
  // `networkidle` is used here as a proxy for "hydration has had a chance to complete", not because
  // network activity itself is the thing being waited on. This method and every call to it below
  // are throwaway for this spike -- if WebKit still fails with it in place, that's evidence against
  // the hypothesis, not a permanent addition to keep.
  async waitForSettled(): Promise<void> {
    await this.page.waitForLoadState("networkidle");
  }
}
