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
}
