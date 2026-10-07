/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS, AC-049): page object for the wedding detail page's Comments tab
 * (apps/web/src/app/weddings/[weddingId]/components/CommentsTab.tsx). No `data-testid` attributes
 * exist anywhere in that component, so every locator here is built from accessible role/name or
 * the component's own aria-label/visible-text strings, read directly from its source.
 */

import { BasePage } from "./BasePage.js";

export type CommentTargetType = "GUEST" | "TABLE" | "TIMELINE_ENTRY";

export class CommentsTabPage extends BasePage {
  private commentsTabButton() {
    return this.page.getByRole("tab", { name: "Comments", exact: true });
  }

  private targetTypeSelect() {
    return this.page.getByLabel("Comment target type");
  }

  private targetSelect(targetType: CommentTargetType) {
    const label =
      targetType === "GUEST" ? "Select a guest" : targetType === "TABLE" ? "Select a table" : "Select a timeline entry";
    return this.page.getByLabel(label, { exact: true });
  }

  private commentTextArea() {
    return this.page.getByLabel("Comment text");
  }

  private postCommentButton() {
    return this.page.getByRole("button", { name: /^post comment$|^posting\.\.\.$/i });
  }

  // The read-only notice CommentsTab renders in place of the compose form for a View-level user.
  viewOnlyNotice() {
    return this.page.getByText("You have View-only access", { exact: false });
  }

  commentsHeading(count: number) {
    return this.page.getByText(`Comments (${count})`, { exact: true });
  }

  async goto(weddingId: string): Promise<void> {
    await this.page.goto(`/weddings/${weddingId}`);
    await this.commentsTabButton().click();
  }

  async postComment(targetType: CommentTargetType, targetLabel: string, body: string): Promise<void> {
    await this.targetTypeSelect().selectOption(targetType);
    await this.targetSelect(targetType).selectOption({ label: targetLabel });
    await this.commentTextArea().fill(body);
    await this.postCommentButton().click();
    // The button's own accessible name flips to "Posting..." while in flight and back to
    // "Post comment" once the request settles -- a fresh locator for the ready-state name is a
    // real wait for that (same pattern as PlanTabPage.generate()), not a fixed sleep.
    await this.page.getByRole("button", { name: "Post comment", exact: true }).waitFor();
  }

  /** The `<li>` for one top-level comment thread, located by its own posted body text. */
  threadByBody(body: string) {
    return this.page.locator("li").filter({ hasText: body });
  }

  // TS-118: replying to and resolving a thread through the UI.
  replyOpener(threadBody: string) {
    // TS-212: the button names the comment it replies to ("Reply to Ann's comment on Table 1").
    return this.threadByBody(threadBody).first().getByRole("button", { name: /^Reply to / });
  }

  async reply(threadBody: string, text: string): Promise<void> {
    const thread = this.threadByBody(threadBody).first();
    await this.replyOpener(threadBody).click();
    await thread.getByLabel("Reply text", { exact: true }).fill(text);
    await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === "POST" && /\/comments$/.test(new URL(r.url()).pathname)),
      thread.getByRole("button", { name: "Reply", exact: true }).click(),
    ]);
  }

  /** TS-151: double-clicks Reply and returns how many replies the page sent. Both clicks are
   * dispatched before the first reply comes back, so counting up to that response is exact. */
  async doubleClickReply(threadBody: string, text: string): Promise<number> {
    const thread = this.threadByBody(threadBody).first();
    await this.replyOpener(threadBody).click();
    await thread.getByLabel("Reply text", { exact: true }).fill(text);
    let sent = 0;
    const count = (r: { method(): string; url(): string }) => {
      if (r.method() === "POST" && /\/comments$/.test(new URL(r.url()).pathname)) sent++;
    };
    this.page.on("request", count);
    try {
      await Promise.all([
        this.page.waitForResponse((r) => r.request().method() === "POST" && /\/comments$/.test(new URL(r.url()).pathname)),
        thread.getByRole("button", { name: "Reply", exact: true }).dblclick(),
      ]);
    } finally {
      this.page.off("request", count);
    }
    return sent;
  }

  async resolve(threadBody: string): Promise<void> {
    await this.resolveButton(threadBody).click();
  }

  /** TS-212: the thread's Resolve button (its name says whose comment, on what). */
  resolveButton(threadBody: string) {
    return this.threadByBody(threadBody).first().getByRole("button", { name: /^Resolve / });
  }

  resolvedBadge(threadBody: string) {
    return this.threadByBody(threadBody).first().getByText("Resolved", { exact: true });
  }

  /** The "(removed)" marker a thread shows once its guest/table/entry has been deleted. */
  removedMarker(threadBody: string) {
    return this.threadByBody(threadBody).first().getByText("(removed)", { exact: true });
  }
}
