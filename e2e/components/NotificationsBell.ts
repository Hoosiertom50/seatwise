/**
 * TS-118 — component object for the notifications bell (apps/web/src/components/NotificationsBell.tsx),
 * shown on the dashboard and on every wedding page. The bell's accessible name carries the unread
 * count ("Notifications (3 unread)"), and its red badge shows the count, capped at "9+".
 */

import type { Locator, Page } from "@playwright/test";

export class NotificationsBell {
  constructor(private readonly page: Page) {}

  bell(): Locator {
    return this.page.getByRole("button", { name: /^Notifications( \(\d+ unread\))?$/ });
  }

  /** The red unread badge inside the bell (absent when nothing is unread). */
  badge(): Locator {
    return this.bell().locator("span");
  }

  /** The open panel. TS-199: a named region (it's pinned to the screen edges on a phone, so it is
   * no longer always `absolute`). */
  panel(): Locator {
    return this.page.getByRole("region", { name: "Notifications", exact: true });
  }

  async toggle(): Promise<void> {
    await this.bell().click();
  }

  emptyMessage(): Locator {
    return this.panel().getByText("No notifications yet.", { exact: true });
  }

  /** One notification in the panel, by part of its message. */
  item(messageContains: string): Locator {
    return this.panel().getByRole("button").filter({ hasText: messageContains });
  }

  /** The blue "unread" dot on an item. */
  unreadDot(messageContains: string): Locator {
    return this.item(messageContains).locator("span.rounded-full");
  }

  markAllReadButton(): Locator {
    return this.panel().getByRole("button", { name: "Mark all read", exact: true });
  }
}
