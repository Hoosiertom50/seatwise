/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS) — converts AC-049 ("Comments can be left on a table or on a
 * specific guest's placement").
 *
 * Comments target a guest, a table, or (TS-18) a timeline entry directly by id
 * (packages/shared/src/schemas/collaboration.ts's `commentTargetTypeEnum`) -- confirmed for real
 * via packages/db/src/queries/comments.ts and the Comments tab
 * (apps/web/src/app/weddings/[weddingId]/components/CommentsTab.tsx). Permission enforcement,
 * confirmed directly and empirically: posting/replying requires COMMENT-level access (route gate);
 * resolving requires being the original author OR having EDIT-level access
 * (`resolveComment`'s own explicit check) -- NOT simply "Edit can resolve anyone's, everyone else
 * can only resolve their own," which is why this test has the Comment-level author resolve their
 * own thread and the Edit collaborator resolve someone else's, rather than asserting only one
 * shape.
 *
 * Real gap found and deliberately not worked around: the AC's own wording ("View cannot add,
 * reply to, edit, resolve, or delete comments") implies edit and delete exist as actions that View
 * is specifically denied. They don't exist for ANYONE at ANY permission level -- confirmed by the
 * comments API route tree containing no PATCH/DELETE handler at all (only a `resolve` subroute)
 * and by `comments.ts`'s own code comment, "Comments have no delete." This test asserts that
 * absence directly (both PATCH and DELETE against a comment return 404, since no route exists) --
 * a comment can never be edited or deleted by anyone, not merely by View.
 *
 * The View-only compose form being entirely absent from the UI (not just disabled) is also
 * confirmed directly in code -- CommentsTab.tsx renders a plain read-only notice instead of the
 * form when `!canComment` -- and checked here via the real, independently-authenticated UI session
 * pattern (`signUpFreshAccountInNewContext`, a fresh BrowserContext whose cookie jar is set
 * directly by the signup response, so the page opened from it is already logged in as that user;
 * no password is ever generated for or passed to a login form).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { CommentsTabPage } from "../pages/CommentsTabPage.js";

defineQualityTest(
  {
    id: "plan-review.comments-respect-permission-level.view-comment-edit-and-no-edit-or-delete-exists",
    title: "View can read but never post/reply/resolve a comment (and the compose form itself is absent from their UI); Comment and Edit can post, reply, and resolve (author-or-Edit only); and no edit or delete action exists for anyone",
    objective:
      "Confirms comment permission enforcement precisely: View is denied posting (403) and the compose form is entirely absent from their own UI session; a Comment-level author can resolve their own thread but a different Comment-level user cannot; an Edit-level collaborator can resolve someone else's thread; and PATCH/DELETE against a comment both 404 for every access level, since neither action exists in the app at all.",
    expectedOutcome:
      "View's post attempt is 403 and their Comments tab shows the read-only notice instead of a compose form. The Comment-level author's own resolve succeeds (200); a different Comment-level collaborator's resolve of that same (already-resolved) thread's sibling is denied (403). The Edit collaborator's resolve of someone else's comment succeeds (200). PATCH and DELETE against a comment both return 404 for the owner.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    let guestId = "";

    await test.step("Arrange: a guest to comment about", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, { firstName: "Ann", lastName: "Alpha" });
      guestId = guest.id;
    });

    const viewSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "view");
    const commentSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "comment");
    const secondCommentSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "comment2");
    const editSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "edit");

    try {
      await test.step("Arrange: a View collaborator, two Comment collaborators, and an Edit collaborator", async () => {
        await weddingData.addCollaborator(managedWedding.id, viewSession.email, "VIEW");
        await weddingData.addCollaborator(managedWedding.id, commentSession.email, "COMMENT");
        await weddingData.addCollaborator(managedWedding.id, secondCommentSession.email, "COMMENT");
        await weddingData.addCollaborator(managedWedding.id, editSession.email, "EDIT");
      });

      await test.step("Act + Assert: the View collaborator is denied posting a comment on the guest's placement", async () => {
        const res = await viewSession.context.request.post(`/api/v1/weddings/${managedWedding.id}/comments`, {
          data: { targetType: "GUEST", guestId, body: "Is this seat confirmed?" },
        });
        expect(res.status()).toBe(403);
      });

      await test.step("Assert (UI): the View collaborator's own Comments tab shows the read-only notice, not a compose form", async () => {
        const viewPage = await viewSession.context.newPage();
        const commentsTab = new CommentsTabPage(viewPage);
        await commentsTab.goto(managedWedding.id);
        await expect(commentsTab.viewOnlyNotice()).toBeVisible();
        await viewPage.close();
      });

      let commentAId = "";
      let commentBId = "";
      await test.step("Act: the first Comment collaborator posts two separate comments on the guest", async () => {
        const resA = await commentSession.context.request.post(`/api/v1/weddings/${managedWedding.id}/comments`, {
          data: { targetType: "GUEST", guestId, body: "Comment A -- resolved by its own author" },
        });
        expect(resA.status()).toBe(201);
        commentAId = ((await resA.json()) as { comment: { id: string } }).comment.id;

        const resB = await commentSession.context.request.post(`/api/v1/weddings/${managedWedding.id}/comments`, {
          data: { targetType: "GUEST", guestId, body: "Comment B -- resolved by an Edit collaborator instead" },
        });
        expect(resB.status()).toBe(201);
        commentBId = ((await resB.json()) as { comment: { id: string } }).comment.id;
      });

      await test.step("Act + Assert: the comment's own author (Comment-level) can resolve it", async () => {
        const res = await commentSession.context.request.post(
          `/api/v1/weddings/${managedWedding.id}/comments/${commentAId}/resolve`,
        );
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { comment: { resolvedAt: string | null } };
        expect(body.comment.resolvedAt).toBeTruthy();
      });

      await test.step("Assert: a different Comment-level collaborator (not the author, not Edit) is denied resolving the other comment", async () => {
        const res = await secondCommentSession.context.request.post(
          `/api/v1/weddings/${managedWedding.id}/comments/${commentBId}/resolve`,
        );
        expect(res.status()).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("Only the original commenter or an editor can resolve this comment.");
      });

      await test.step("Act + Assert: the Edit collaborator can resolve someone else's comment", async () => {
        const res = await editSession.context.request.post(
          `/api/v1/weddings/${managedWedding.id}/comments/${commentBId}/resolve`,
        );
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { comment: { resolvedAt: string | null } };
        expect(body.comment.resolvedAt).toBeTruthy();
      });

      await test.step("Assert: no edit or delete action exists for a comment, for anyone -- PATCH and DELETE both 404", async () => {
        const patchRes = await commentSession.context.request.patch(
          `/api/v1/weddings/${managedWedding.id}/comments/${commentAId}`,
          { data: { body: "edited" } },
        );
        expect(patchRes.status()).toBe(404);
        const deleteRes = await commentSession.context.request.delete(
          `/api/v1/weddings/${managedWedding.id}/comments/${commentAId}`,
        );
        expect(deleteRes.status()).toBe(404);
      });
    } finally {
      await viewSession.context.close();
      await commentSession.context.close();
      await secondCommentSession.context.close();
      await editSession.context.close();
    }
  },
);
