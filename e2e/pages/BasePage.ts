/**
 * Stage 03 — base page-object pattern (spec Section 7.2 / Stage 03 tasks).
 *
 * Every page object receives its `Page` through the constructor (never reads a module-level or
 * static `page` reference), so it holds no global mutable browser state and is safe to construct
 * fresh per test/fixture without any cross-test leakage. Subclasses expose business-readable
 * operations (`login(...)`, `addGuest(...)`) rather than raw selector/click sequences — selectors
 * themselves stay private to the page object per spec Section 7.2's centralization rule.
 */

import type { Page } from "@playwright/test";

export abstract class BasePage {
  constructor(protected readonly page: Page) {}
}
