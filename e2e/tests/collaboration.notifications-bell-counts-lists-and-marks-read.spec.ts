/**
 * TS-118 (REQ-COLLABORATION-NOTIFICATIONS) — the notifications bell, which the 2026-09-30 coverage
 * audit found untested: its empty state, its unread count and badge (capped at "9+"), opening and
 * closing it, marking one notification read, and marking them all read.
 *
 * Notifications are produced the real way: a collaborator replies to the owner's comment, and
 * every reply notifies everyone on the wedding except whoever wrote it (FR-10.2).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { NotificationsBell } from "../components/NotificationsBell.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "collaboration.notifications-bell-counts-lists-and-marks-read.empty-count-9plus-one-all",
    title: "the notifications bell shows nothing yet, then the unread count (capped at 9+), lists each notification, and marks one or all read",
    objective:
      "Confirms the bell says 'No notifications yet.' with no badge for a planner with none; that a collaborator's reply makes it read 'Notifications (1 unread)' with a 1 badge and lists the reply with an unread dot; that clicking it marks it read; that ten more show '9+' while the count reads 10; that 'Mark all read' clears the badge and the server's unread count; and that clicking outside closes the panel.",
    expectedOutcome:
      "Empty: the message shows and there's no badge. One reply: badge '1', the item shows the reply text with a dot, and after clicking it the bell reads 'Notifications'. Ten more: badge '9+', label '(10 unread)'. After Mark all read: no badge, and GET /notifications reports unreadCount 0. Clicking outside hides the panel.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const bell = new NotificationsBell(page);
    const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const parent = await context.request.post(`/api/v1/weddings/${w}/comments`, {
      data: { targetType: "GUEST", guestId: guest.id, body: "Can someone confirm their meal?" },
    });
    expect(parent.ok()).toBe(true);
    const parentId = ((await parent.json()) as { comment: { id: string } }).comment.id;

    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "replier");
    await weddingData.addCollaborator(w, helper.email, "EDIT");
    const reply = async (body: string) => {
      const res = await helper.context.request.post(`/api/v1/weddings/${w}/comments`, {
        data: { targetType: "GUEST", guestId: guest.id, body, parentCommentId: parentId },
      });
      expect(res.ok()).toBe(true);
    };

    try {
      await test.step("Nothing yet: no badge, and the panel says so", async () => {
        await page.goto("/dashboard");
        await expect(bell.bell()).toHaveAccessibleName("Notifications");
        await expect(bell.badge()).toHaveCount(0);
        await bell.toggle();
        await expect(bell.emptyMessage()).toBeVisible();
        await bell.toggle();
        await expect(bell.panel()).toHaveCount(0);
      });

      await test.step("One reply: a 1 badge, the reply listed as unread, and clicking it marks it read", async () => {
        await reply("Chicken, confirmed by phone");
        await page.reload();
        await expect(bell.bell()).toHaveAccessibleName("Notifications (1 unread)");
        await expect(bell.badge()).toHaveText("1");
        await bell.toggle();
        await expect(bell.item("Chicken, confirmed by phone")).toBeVisible();
        await expect(bell.unreadDot("Chicken, confirmed by phone")).toHaveCount(1);
        await bell.item("Chicken, confirmed by phone").click();
        await expect(bell.unreadDot("Chicken, confirmed by phone")).toHaveCount(0);
        await expect(bell.bell()).toHaveAccessibleName("Notifications");
      });

      await test.step("Ten more: the badge caps at 9+, and Mark all read clears everything", async () => {
        for (let i = 1; i <= 10; i++) await reply(`Follow-up ${i}`);
        await page.reload();
        await expect(bell.bell()).toHaveAccessibleName("Notifications (10 unread)");
        await expect(bell.badge()).toHaveText("9+");
        await bell.toggle();
        await bell.markAllReadButton().click();
        await expect(bell.badge()).toHaveCount(0);
        await expect(bell.markAllReadButton()).toHaveCount(0);
        await expect
          .poll(async () => ((await (await context.request.get("/api/v1/notifications")).json()) as { unreadCount: number }).unreadCount)
          .toBe(0);
      });

      await test.step("Clicking outside closes the panel", async () => {
        await expect(bell.panel()).toBeVisible();
        await page.mouse.click(5, 5);
        await expect(bell.panel()).toHaveCount(0);
      });
    } finally {
      await helper.context.close();
    }
  },
);
