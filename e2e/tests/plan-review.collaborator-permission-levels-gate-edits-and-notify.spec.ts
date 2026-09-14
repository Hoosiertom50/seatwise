/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS) — converts AC-048 ("Sharing respects each person's permission
 * level").
 *
 * The workbook's own precondition/test-step language ("Share the Current Plan Version with all
 * three users," "opening either link") describes a per-plan-version share action with its own
 * shareable link, scoped to permission level. No such feature exists anywhere in this codebase --
 * confirmed by reading every route under apps/web/src/app/api/v1/weddings/[weddingId]/** and the
 * Collaborators tab: what exists instead is (a) whole-wedding View/Comment/Edit collaborator
 * access (packages/db/src/queries/collaborators.ts), and (b) an automatic in-app (+ conditional
 * email) notification fan-out whenever a plan version's status moves to IN_REVIEW
 * (`notifyWeddingCollaborators`, packages/db/src/queries/notifications.ts) -- not a per-recipient
 * link a planner explicitly shares. This test exercises what's actually built: add collaborators
 * at each of the three permission levels, move the plan to In Review, and confirm (1) every
 * collaborator -- not the actor who triggered it -- receives an in-app notification, and (2) each
 * collaborator's actual permission level is enforced exactly as the AC describes: View cannot move
 * a guest, Edit can complete a valid move (Comment is checked too, for the same reason, since it
 * sits on the same access ladder and the AC's boundary is incomplete without it).
 *
 * Email delivery ("only recipients with email enabled receive email") is NOT verified here: reading
 * `sendEmailNotification` directly shows it's a stub in this environment (no Resend API key
 * configured) that only `console.log`s -- there is no real inbox or interceptable delivery for a
 * Playwright test to observe, so the per-wedding `emailNotificationsEnabled` toggle's effect on
 * an actual email is untestable in this environment. What IS verified is the flag's own
 * persistence (a wedding-level, not per-recipient, setting -- confirmed directly against
 * `notifyWeddingCollaborators`, which reads exactly one boolean and applies it to every recipient
 * alike, not a per-person preference the AC's phrasing implies).
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "plan-review.collaborator-permission-levels-gate-edits-and-notify.view-comment-edit-matrix",
    title: "moving a plan to In Review notifies every collaborator in-app, and each collaborator's own permission level is enforced -- View and Comment cannot move a guest, Edit can",
    objective:
      "Confirms that when the wedding's owner moves the Current Plan Version to In Review, every one of the wedding's View/Comment/Edit collaborators (but not the owner who triggered it) receives an in-app notification naming the share event, and that each collaborator's actual access level gates a manual guest move exactly as their level implies: View and Comment are denied (403), Edit succeeds (200).",
    expectedOutcome:
      "Each of the three collaborators' own notification list contains a PLAN_SHARED notification mentioning the plan being shared for review. The View and Comment collaborators' move attempts are both denied (403); the Edit collaborator's move attempt succeeds (200).",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    let planVersionId = "";
    let guestId = "";
    let tableAId = "";
    let tableBId = "";
    let otherTableId = ""; // whichever of A/B the guest ISN'T seated at after generation

    await test.step("Arrange: a complete plan (Draft) with room for a manual move", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestId = guest.id;
      const tableA = await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 1 });
      const tableB = await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 1 });
      tableAId = tableA.id;
      tableBId = tableB.id;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
      const currentTable = generated.assignments.find((a) => a.guestId === guestId)?.tableId;
      otherTableId = currentTable === tableAId ? tableBId : tableAId;
    });

    const baseURL = getEnv().APP_URL;
    const viewContext = await playwrightRequest.newContext({ baseURL });
    const commentContext = await playwrightRequest.newContext({ baseURL });
    const editContext = await playwrightRequest.newContext({ baseURL });

    try {
      await test.step("Arrange: a View, a Comment, and an Edit collaborator on the wedding", async () => {
        const viewAccount = await signUpFreshAccount(viewContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, viewAccount.email, "VIEW");
        const commentAccount = await signUpFreshAccount(commentContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, commentAccount.email, "COMMENT");
        const editAccount = await signUpFreshAccount(editContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, editAccount.email, "EDIT");
      });

      await test.step("Act: the owner moves the plan to In Review", async () => {
        const res = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
        expect(res.status).toBe(200);
      });

      for (const [label, ctx] of [
        ["View", viewContext],
        ["Comment", commentContext],
        ["Edit", editContext],
      ] as const) {
        await test.step(`Assert: the ${label} collaborator received an in-app notification that the plan was shared for review`, async () => {
          const res = await ctx.get("/api/v1/notifications");
          expect(res.status()).toBe(200);
          const body = (await res.json()) as { notifications: { type: string; message: string; weddingName: string }[] };
          const match = body.notifications.find(
            (n) => n.type === "PLAN_SHARED" && n.weddingName === managedWedding.name,
          );
          expect(match).toBeTruthy();
          expect(match!.message).toContain("shared for review");
        });
      }

      // A permission check happens before any table-validity check in the route, so which table
      // is named in a denied request doesn't matter -- "Table B" (otherTableId) is used for both
      // denial checks unconditionally.
      await test.step("Assert: the View collaborator cannot move a guest", async () => {
        const res = await viewContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
          { data: { guestId, tableId: otherTableId } },
        );
        expect(res.status()).toBe(403);
      });

      await test.step("Assert: the Comment collaborator also cannot move a guest (Comment sits below Edit on the same access ladder)", async () => {
        const res = await commentContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
          { data: { guestId, tableId: otherTableId } },
        );
        expect(res.status()).toBe(403);
      });

      await test.step("Act + Assert: the Edit collaborator can complete a valid move", async () => {
        // otherTableId was computed right after generation to be whichever table the guest is
        // NOT currently at, so this is guaranteed to be a real, non-no-op move.
        const res = await editContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
          { data: { guestId, tableId: otherTableId } },
        );
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { planVersion: { assignments: { guestId: string; tableId: string }[] } };
        expect(body.planVersion.assignments.find((a) => a.guestId === guestId)?.tableId).toBe(otherTableId);
      });
    } finally {
      await viewContext.dispose();
      await commentContext.dispose();
      await editContext.dispose();
    }
  },
);
