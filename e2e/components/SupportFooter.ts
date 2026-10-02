/**
 * TS-100 — the "Contact support" footer at the bottom of every page
 * (apps/web/src/components/SupportFooter.tsx).
 */

import type { Locator, Page } from "@playwright/test";

export class SupportFooter {
  constructor(private readonly page: Page) {}

  root(): Locator {
    return this.page.getByRole("contentinfo");
  }

  contactLink(): Locator {
    return this.root().getByRole("link", { name: "Contact support", exact: true });
  }
}
