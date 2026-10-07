/**
 * TS-221 / TS-223 (REQ-COLLABORATION-NOTIFICATIONS) — the Comments tab while it stays open.
 * - Comments loaded once, so a comment, reply or resolve made elsewhere only showed after switching
 *   tabs (the bell announced it). Now the tab fetches them again every 4 seconds, and holds off
 *   while a comment is being written.
 * - A comment of only spaces said "Validation failed"; now it says what to do.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CommentsTabPage } from "../pages/CommentsTabPage.js";

defineQualityTest(
  {
    id: "collaboration.comments-tab-keeps-up-and-explains-an-empty-comment.refresh-and-blank",
    title: "the open Comments tab shows comments, replies and resolves made elsewhere, waits while a draft is being written, and a blank comment says what to do",
    objective:
      "Confirms that with the Comments tab open, a comment posted elsewhere appears without leaving the tab, a reply and a resolve made elsewhere show too, nothing new appears while a draft is being typed (and does once it's cleared), and that posting a comment of only spaces shows 'Write something first.' rather than 'Validation failed'.",
    expectedOutcome:
      "The comment posted through the API appears in the open tab within the poll interval, followed by its reply and the Resolved badge. A comment posted while a draft is in the box doesn't appear for 6 seconds, then appears once the draft is cleared. Posting only spaces shows 'Write something first.', never 'Validation failed', and nothing is saved.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }) => {
    const w = managedWedding.id;
    const comments = new CommentsTabPage(page);
    const table = await weddingData.createTable(w, { label: "Head Table", capacity: 8 });
    await comments.goto(w);
    await expect(comments.commentsHeading(0)).toBeVisible();

    await test.step("A comment, reply and resolve made elsewhere show in the open tab", async () => {
      const posted = await weddingData.postComment(w, { targetType: "TABLE", tableId: table.id, body: "Posted from another browser" });
      expect(posted.status).toBe(201);
      await expect(comments.threadByBody("Posted from another browser").first()).toBeVisible({ timeout: 10_000 });
      const reply = await weddingData.postComment(w, {
        targetType: "TABLE",
        tableId: table.id,
        body: "A reply from elsewhere",
        parentCommentId: posted.body.comment!.id,
      });
      expect(reply.status).toBe(201);
      await expect(comments.threadByBody("Posted from another browser").first()).toContainText("A reply from elsewhere", { timeout: 10_000 });
      expect((await weddingData.resolveComment(w, posted.body.comment!.id)).status).toBe(200);
      await expect(comments.resolvedBadge("Posted from another browser")).toBeVisible({ timeout: 10_000 });
    });

    await test.step("Nothing new appears while a draft is being written; it does once the draft is cleared", async () => {
      await comments.typeDraft("Half-written thought");
      let commentFetches = 0;
      const countFetches = (r: { method(): string; url(): string }) => {
        if (r.method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}/comments`) commentFetches++;
      };
      page.on("request", countFetches);
      try {
        expect((await weddingData.postComment(w, { targetType: "TABLE", tableId: table.id, body: "Arrived during a draft" })).status).toBe(201);
        // Two of the page's own 4-second access checks -- more than one poll interval -- pass
        // with the draft in the box: the tab holds off and never fetches the comments.
        const pagePoll = (r: { method(): string; url(): string }) =>
          r.method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`;
        await page.waitForRequest(pagePoll, { timeout: 10_000 });
        await page.waitForRequest(pagePoll, { timeout: 10_000 });
      } finally {
        page.off("request", countFetches);
      }
      expect(commentFetches).toBe(0);
      await expect(comments.threadByBody("Arrived during a draft")).toHaveCount(0);
      await comments.typeDraft("");
      await expect(comments.threadByBody("Arrived during a draft").first()).toBeVisible({ timeout: 10_000 });
    });

    await test.step("A comment of only spaces says what to do, not 'Validation failed'", async () => {
      await comments.submitComment("TABLE", "Head Table", "    ");
      await expect(comments.errorMessage("Write something first.")).toBeVisible();
      await expect(comments.errorMessage("Validation failed")).toHaveCount(0);
      await expect(comments.commentsHeading(2)).toBeVisible();
    });
  },
);
