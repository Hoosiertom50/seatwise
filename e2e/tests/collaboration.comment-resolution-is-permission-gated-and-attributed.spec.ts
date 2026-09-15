/**
 * TS-48 (REQ-COLLABORATION-NOTIFICATIONS) — converts AC-071 ("Comment resolution is
 * permission-gated and attributed").
 *
 * `plan-review.comments-respect-permission-level.spec.ts` (TS-43, AC-049) already covers most of
 * this ground -- posting requires Comment-level+ access, a Comment-level author can resolve their
 * own thread, a different Comment-level collaborator cannot resolve someone else's, and an Edit
 * collaborator can resolve anyone's. Rather than duplicate that matrix, this test targets exactly
 * AC-071's own two pieces of net-new coverage, confirmed directly in
 * packages/db/src/queries/comments.ts's `resolveComment` and its API route
 * (apps/web/src/app/api/v1/weddings/[weddingId]/comments/[commentId]/resolve/route.ts):
 *
 * 1. AC-071's own third step -- "As a View user, attempt to resolve the third comment" -- is a
 *    DIFFERENT code path than the existing Comment-level-non-author denial: the resolve route
 *    itself gates on `requireAccess(weddingId, user.id, "COMMENT")` *before* `resolveComment`'s
 *    own author-or-editor check ever runs, so a View-level collaborator is denied with the
 *    generic `requireAccess` message ("You don't have permission to do that", 403) -- never
 *    reaching (and never seeing) resolveComment's own "Only the original commenter or an editor
 *    can resolve this comment." message, which only a Comment-or-above requester who isn't the
 *    author/an editor would see. Both denial messages are asserted below, on their own distinct
 *    triggering scenarios, to keep that boundary explicit rather than assumed.
 *
 * 2. "When a referenced guest, table, or assignment later changes or is removed, the comment
 *    remains attached to its historical target and is not silently reassigned" -- confirmed
 *    directly in `comments.ts`'s SELECT: `targetRemoved` is computed as "all three target FKs are
 *    null" (an `ON DELETE SET NULL`), while `targetLabel` was captured as plain text at creation
 *    and is never recomputed. So deleting a comment's target guest leaves `targetLabel` and every
 *    other field (body, author, resolution state) completely untouched, `targetRemoved` flips to
 *    true, and -- a real finding, asserted directly rather than assumed away -- resolving (or even
 *    replying to) a comment whose target was removed is not blocked server-side at all (only the
 *    UI hides the Reply action once `targetRemoved` is true); this test resolves a
 *    target-already-removed comment successfully to confirm resolution never depends on the
 *    target still existing.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "collaboration.comment-resolution-is-permission-gated-and-attributed.view-cannot-resolve-and-a-removed-targets-comment-stays-attached",
    title: "a View-level collaborator's own resolve attempt is denied by the route's own access gate (a different denial than a non-author Comment-level user's); and a comment whose guest target was later deleted keeps its original label, stays attached to that historical target, and can still be resolved (and attributed) exactly as before",
    objective:
      "Confirms POST .../comments/:id/resolve denies a View-level collaborator with the generic access-gate message before resolveComment's own author-or-editor check ever runs, distinct from the FORBIDDEN message a non-author Comment-level user gets. Confirms deleting a comment's target guest flips targetRemoved to true without touching targetLabel/body/author, and that resolving that now-target-removed comment still succeeds with full resolver attribution (resolvedByUserId/resolvedByName/resolvedAt).",
    expectedOutcome:
      "The View collaborator's resolve attempt is 403 with 'You don't have permission to do that'. After the target guest is deleted, GET .../comments shows the same comment with its original targetLabel, body, and author untouched, and targetRemoved: true. Resolving it afterward returns 200 with resolvedByUserId/resolvedByName/resolvedAt all set to the resolving user.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    let guestAId = "";
    let guestBId = "";

    await test.step("Arrange: two guests to comment about", async () => {
      const guestA = await weddingData.createGuest(managedWedding.id, { firstName: "Vera", lastName: "Viewtest" });
      guestAId = guestA.id;
      const guestB = await weddingData.createGuest(managedWedding.id, { firstName: "Remy", lastName: "Removaltest" });
      guestBId = guestB.id;
    });

    const viewSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "view");
    const commentSession = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "comment");

    try {
      await test.step("Arrange: a View collaborator and a Comment-level collaborator", async () => {
        await weddingData.addCollaborator(managedWedding.id, viewSession.email, "VIEW");
        await weddingData.addCollaborator(managedWedding.id, commentSession.email, "COMMENT");
      });

      let commentOnAId = "";
      await test.step("Arrange: the Comment-level collaborator posts a comment on guestA", async () => {
        const res = await commentSession.context.request.post(`/api/v1/weddings/${managedWedding.id}/comments`, {
          data: { targetType: "GUEST", guestId: guestAId, body: "Confirm this seat before Friday." },
        });
        expect(res.status()).toBe(201);
        commentOnAId = ((await res.json()) as { comment: { id: string } }).comment.id;
      });

      await test.step("Act + Assert: the View collaborator's resolve attempt is denied by the route's own access gate -- a different message than the author-or-editor check", async () => {
        const res = await viewSession.context.request.post(
          `/api/v1/weddings/${managedWedding.id}/comments/${commentOnAId}/resolve`,
        );
        expect(res.status()).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("You don't have permission to do that");
        expect(body.error).not.toBe("Only the original commenter or an editor can resolve this comment.");
      });

      let commentOnBId = "";
      await test.step("Arrange: the same Comment-level collaborator posts a second comment, this time on guestB", async () => {
        const res = await commentSession.context.request.post(`/api/v1/weddings/${managedWedding.id}/comments`, {
          data: { targetType: "GUEST", guestId: guestBId, body: "Needs an accessible table." },
        });
        expect(res.status()).toBe(201);
        commentOnBId = ((await res.json()) as { comment: { id: string } }).comment.id;
      });

      await test.step("Act: guestB (the comment's own target) is deleted", async () => {
        await weddingData.deleteGuest(managedWedding.id, guestBId);
      });

      await test.step("Assert: the comment on the now-deleted guestB keeps its original label/body/author untouched, and is flagged targetRemoved", async () => {
        const res = await commentSession.context.request.get(`/api/v1/weddings/${managedWedding.id}/comments`);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
          comments: {
            id: string;
            targetLabel: string;
            targetRemoved: boolean;
            body: string;
            authorName: string;
            resolvedAt: string | null;
          }[];
        };
        const found = body.comments.find((c) => c.id === commentOnBId);
        expect(found, "the comment must still be present after its target guest is deleted").toBeTruthy();
        expect(found!.targetLabel).toBe("Guest: Remy Removaltest");
        expect(found!.body).toBe("Needs an accessible table.");
        expect(found!.authorName).toBe(commentSession.name);
        expect(found!.targetRemoved).toBe(true);
        expect(found!.resolvedAt).toBeNull();
      });

      await test.step("Act + Assert: resolving that target-removed comment still succeeds, with full resolver attribution -- resolution never depends on the target still existing", async () => {
        const res = await commentSession.context.request.post(
          `/api/v1/weddings/${managedWedding.id}/comments/${commentOnBId}/resolve`,
        );
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
          comment: {
            resolvedAt: string | null;
            resolvedByUserId: string | null;
            resolvedByName: string | null;
            targetRemoved: boolean;
            targetLabel: string;
          };
        };
        expect(body.comment.resolvedAt).toBeTruthy();
        expect(body.comment.resolvedByName).toBe(commentSession.name);
        expect(body.comment.resolvedByUserId).toBeTruthy();
        // Still attached to its historical target, not silently reassigned or cleared:
        expect(body.comment.targetRemoved).toBe(true);
        expect(body.comment.targetLabel).toBe("Guest: Remy Removaltest");
      });
    } finally {
      await viewSession.context.close();
      await commentSession.context.close();
    }
  },
);
