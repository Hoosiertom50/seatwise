/**
 * TS-46 (REQ-DAY-OF-TIMELINE) — no manual test case or numbered acceptance criterion exists for
 * this requirement; authored directly from `quality/requirements.yaml`'s REQ-DAY-OF-TIMELINE
 * description plus the actual implementation, per the Jira ticket's own instruction.
 *
 * Confirmed directly in the API routes (apps/web/src/app/api/v1/weddings/[weddingId]/
 * timeline-entries/**): reading the timeline requires VIEW-level access; creating, editing,
 * reordering, and removing an entry all require EDIT-level access via the exact same
 * `requireAccess(weddingId, user.id, "EDIT")` gate every other mutating route uses -- nothing
 * timeline-specific. TimelineTab.tsx's own `canEdit` prop (page.tsx: `accessLevel === "OWNER" ||
 * accessLevel === "EDIT"`) hides the add form and every per-entry Edit/Remove/reorder control
 * behind a read-only notice when false, so both a View and a Comment collaborator (Comment sits
 * below Edit on the same ladder) are denied editing -- exercised together, matching this
 * codebase's established permission-matrix pattern (see plan-review.collaborator-permission-
 * levels-gate-edits-and-notify.spec.ts), since the AC's own implied boundary ("only Edit/Owner can
 * change the timeline") is incomplete without checking both levels below it.
 *
 * Comments on a timeline entry (FR-13.3, commentTargetTypeEnum's TIMELINE_ENTRY case) are a
 * separate cross-cutting feature with its own permission tests elsewhere
 * (plan-review.comments-respect-permission-level.spec.ts) and are out of this story's own scope
 * per its Jira description ("creating/editing/reordering/removing entries") -- not re-tested here.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { uniqueToken } from "../data/ids.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";

defineQualityTest(
  {
    id: "timeline.view-only-access-cannot-edit-the-timeline.view-and-comment-are-denied-every-mutation",
    title: "View and Comment collaborators can see the run-of-show but cannot add, edit, reorder, or remove entries -- their own UI shows a read-only notice instead of the editing controls",
    objective:
      "Confirms a View collaborator and a Comment collaborator (Comment sits below Edit on the same access ladder) are both denied every timeline mutation -- create, edit, reorder, remove -- with a 403, while still able to read the timeline (200), and that their own Timeline tab UI renders the read-only notice with no add form and no per-entry Edit/Remove/reorder controls.",
    expectedOutcome:
      "For both the View and the Comment collaborator: POST/PATCH/POST-reorder/DELETE against timeline-entries all return 403, and GET still returns 200 with the existing entry. Their own Timeline tab shows the exact read-only notice text and the add-entry form and per-entry controls are absent from the page.",
    requirementIds: ["REQ-DAY-OF-TIMELINE"],
    tags: ["@mutating", "@feature:timeline", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    const token = testInfo.workerIndex;
    const existingEntry = `Existing entry ${uniqueToken(token)}`;
    let existingEntryId = "";

    await test.step("Arrange: one existing entry for the collaborators to read but not touch", async () => {
      const created = await weddingData.createTimelineEntry(managedWedding.id, { time: "17:00", description: existingEntry });
      expect(created.status).toBe(201);
      existingEntryId = created.body.entry!.id;
    });

    const viewSession = await signUpFreshAccountInNewContext(browser, token, "tl-view");
    const commentSession = await signUpFreshAccountInNewContext(browser, token, "tl-comment");

    try {
      await test.step("Arrange: a View collaborator and a Comment collaborator on the wedding", async () => {
        await weddingData.addCollaborator(managedWedding.id, viewSession.email, "VIEW");
        await weddingData.addCollaborator(managedWedding.id, commentSession.email, "COMMENT");
      });

      for (const [label, session] of [
        ["View", viewSession],
        ["Comment", commentSession],
      ] as const) {
        await test.step(`Assert: the ${label} collaborator can read the timeline but is denied every mutation`, async () => {
          const getRes = await session.context.request.get(`/api/v1/weddings/${managedWedding.id}/timeline-entries`);
          expect(getRes.status()).toBe(200);
          const getBody = (await getRes.json()) as { entries: { description: string }[] };
          expect(getBody.entries.some((e) => e.description === existingEntry)).toBe(true);

          const createRes = await session.context.request.post(
            `/api/v1/weddings/${managedWedding.id}/timeline-entries`,
            { data: { time: "08:00", description: `${label} attempt ${uniqueToken(token)}` } },
          );
          expect(createRes.status()).toBe(403);

          const patchRes = await session.context.request.patch(
            `/api/v1/weddings/${managedWedding.id}/timeline-entries/${existingEntryId}`,
            { data: { description: `${label} edited it` } },
          );
          expect(patchRes.status()).toBe(403);

          const reorderRes = await session.context.request.post(
            `/api/v1/weddings/${managedWedding.id}/timeline-entries/${existingEntryId}/reorder`,
            { data: { direction: "UP" } },
          );
          expect(reorderRes.status()).toBe(403);

          const deleteRes = await session.context.request.delete(
            `/api/v1/weddings/${managedWedding.id}/timeline-entries/${existingEntryId}`,
          );
          expect(deleteRes.status()).toBe(403);
        });
      }

      await test.step("Assert (UI): the Comment collaborator's own Timeline tab shows the read-only notice, with no add form and no per-entry controls", async () => {
        const commentPage = await commentSession.context.newPage();
        const timeline = new TimelineTabPage(commentPage);
        await timeline.goto(managedWedding.id);

        await expect(timeline.viewOnlyNotice()).toBeVisible();
        await expect(timeline.addTimeInputLocator()).toHaveCount(0);
        await expect(timeline.addDescriptionInputLocator()).toHaveCount(0);
        await expect(timeline.allEditButtons()).toHaveCount(0);
        await expect(timeline.allRemoveButtons()).toHaveCount(0);
        await expect(timeline.allMoveUpButtons()).toHaveCount(0);
        await expect(timeline.allMoveDownButtons()).toHaveCount(0);
        // The existing entry is still visible -- read access is intact, only editing is hidden.
        await expect(timeline.textLocator(existingEntry, true)).toBeVisible();

        await commentPage.close();
      });

      // Confirms the four denied mutations above truly changed nothing.
      await test.step("Assert: the timeline is untouched after every denied attempt", async () => {
        const entries = await weddingData.getTimelineEntries(managedWedding.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe(existingEntryId);
        expect(entries[0].description).toBe(existingEntry);
      });
    } finally {
      await viewSession.context.close();
      await commentSession.context.close();
    }
  },
);
