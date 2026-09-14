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
    return this.page.getByRole("button", { name: "Comments", exact: true });
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
}
