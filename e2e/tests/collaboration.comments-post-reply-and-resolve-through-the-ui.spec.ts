/**
 * TS-118 (REQ-COLLABORATION-NOTIFICATIONS) — the Comments tab through the real UI, which the
 * 2026-09-30 coverage audit found untested beyond posting a guest comment: comments about a table
 * and about a timeline entry, replying, resolving, a thread whose target has since been removed,
 * and a reply to a comment that doesn't exist.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { CommentsTabPage } from "../pages/CommentsTabPage.js";

defineQualityTest(
  {
    id: "collaboration.comments-post-reply-and-resolve-through-the-ui.targets-reply-resolve-removed-missing-parent",
    title: "comments can be posted about a guest, a table and a timeline entry, replied to and resolved from the Comments tab; a removed target keeps its thread read-only, and a reply to a missing comment is refused",
    objective:
      "Confirms that the Comments tab posts a comment about a guest, a table and a timeline entry (each listed under its target's name), that a reply posted from a thread appears under it, that Resolve marks the thread Resolved and removes the button, that a thread whose guest was removed shows '(removed)' and offers no Reply, and that replying to a comment id that doesn't exist is refused with 'Parent comment not found.'.",
    expectedOutcome:
      "Comments (3) lists all three with their target names; the reply text shows inside its thread; after Resolve the thread shows 'Resolved' with no Resolve button and the API has resolvedAt set; after the guest is deleted the thread shows '(removed)' with no Reply button; the bogus-parent reply returns 404 with 'Parent comment not found.'.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }, testInfo) => {
    const w = managedWedding.id;
    const comments = new CommentsTabPage(page);
    const name = uniquePersonName(testInfo.workerIndex);
    const guest = await weddingData.createGuest(w, name);
    await weddingData.createTable(w, { label: "Head Table", capacity: 8 });
    await weddingData.createTimelineEntry(w, { time: "17:30", description: "Cocktail hour" });
    const listComments = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}/comments`)).json()) as {
        comments: { id: string; body: string; resolvedAt: string | null; parentCommentId: string | null }[];
      }).comments;

    await comments.goto(w);

    await test.step("A comment about a guest, a table and a timeline entry", async () => {
      await comments.postComment("GUEST", `${name.firstName} ${name.lastName}`, "Vegetarian meal confirmed?");
      await comments.postComment("TABLE", "Head Table", "Move closer to the dance floor?");
      await comments.postComment("TIMELINE_ENTRY", "17:30 — Cocktail hour", "Band starts late");
      await expect(comments.commentsHeading(3)).toBeVisible();
      await expect(comments.threadByBody("Move closer to the dance floor?").first()).toContainText("Head Table");
      await expect(comments.threadByBody("Band starts late").first()).toContainText("Cocktail hour");
    });

    await test.step("A reply appears under its thread", async () => {
      await comments.reply("Move closer to the dance floor?", "Venue says yes");
      await expect(comments.threadByBody("Move closer to the dance floor?").first()).toContainText("Venue says yes");
      await expect.poll(async () => (await listComments()).find((c) => c.body === "Venue says yes")?.parentCommentId).toBeTruthy();
    });

    await test.step("Resolve marks the thread resolved", async () => {
      await comments.resolve("Band starts late");
      await expect(comments.resolvedBadge("Band starts late")).toBeVisible();
      await expect(
        comments.threadByBody("Band starts late").first().getByRole("button", { name: "Resolve", exact: true }),
      ).toHaveCount(0);
      await expect.poll(async () => (await listComments()).find((c) => c.body === "Band starts late")?.resolvedAt).toBeTruthy();
    });

    await test.step("A thread whose guest was removed is marked and can't be replied to", async () => {
      await weddingData.deleteGuest(w, guest.id);
      await comments.goto(w);
      await expect(comments.removedMarker("Vegetarian meal confirmed?")).toBeVisible();
      await expect(comments.replyOpener("Vegetarian meal confirmed?")).toHaveCount(0);
    });

    await test.step("A reply to a comment that doesn't exist is refused", async () => {
      const tables = await weddingData.listTables(w);
      const res = await context.request.post(`/api/v1/weddings/${w}/comments`, {
        data: { targetType: "TABLE", tableId: tables[0].id, body: "Orphan", parentCommentId: "no-such-comment" },
      });
      expect(res.status()).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("Parent comment not found.");
    });
  },
);
