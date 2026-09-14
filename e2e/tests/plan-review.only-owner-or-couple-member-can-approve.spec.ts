/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS) — converts AC-050 ("Only the Planner/Owner or Couple can mark a
 * plan Approved").
 *
 * Read directly against the status route
 * (apps/web/src/app/api/v1/weddings/[weddingId]/plan-versions/[planVersionId]/status/route.ts)
 * and empirically confirmed against the real running app: approving is gated more narrowly than
 * "Owner or Couple" alone -- a Couple member also needs at least Comment-level access (a Couple
 * member left at View is still denied), while a plain (non-Couple) Collaborator is denied at
 * Approve regardless of their permission level, even Edit. Draft<->In Review, by contrast, only
 * needs Edit-level access (Owner, Edit-level Collaborator, or Edit-level Couple) and doesn't care
 * about the Couple role at all -- confirmed here too, since the AC's own first test step exercises
 * it ("As an Edit Collaborator, move it to In Review and attempt to approve it").
 *
 * Real UI gap found and deliberately not worked around: apps/web/src/app/weddings/[weddingId]/
 * page.tsx computes `canEdit = accessLevel === "OWNER" || accessLevel === "EDIT"`, and PlanTab.tsx
 * renders its entire status-control block (Move to review/Approve/etc.) only when
 * `detail.isCurrent && canEdit`. A Couple member at Comment-only access -- whom the API above
 * explicitly authorizes to approve -- therefore never sees an Approve button at all; the action is
 * reachable only via a direct API call for that user, never through the UI as built. This test
 * exercises the real, API-level behavior the AC describes rather than a UI click path that doesn't
 * exist for a Comment-level Couple member.
 *
 * Also confirmed: approving requires the plan to be complete (`isComplete`) -- already covered by
 * TS-38's completeness reporting, not re-proven here -- so this test builds a plan that's
 * trivially complete (one guest, one table) to isolate the *who* question. Each of the three
 * non-owner accounts below is signed up through its own independent `request.newContext()` (same
 * pattern TS-39's access-control test established for a second identity) since each needs its own
 * cookie jar to be a genuinely separate, independently-authenticated session.
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";

defineQualityTest(
  {
    id: "plan-review.only-owner-or-couple-member-can-approve.role-and-permission-matrix",
    title: "Draft<->In Review only needs Edit access, but Approve is narrower: only the owner, or a Couple member with at least Comment access, may approve -- a plain Collaborator at Edit is denied, and a Couple member left at View is denied",
    objective:
      "Confirms the plan-review status route's approval gate precisely: an Edit-level plain Collaborator can move Draft<->In Review but is denied at Approve; a Couple member at View access is denied at Approve; a Couple member at Comment access succeeds at Approve; and the wedding's own owner always succeeds at Approve.",
    expectedOutcome:
      "The Edit Collaborator's move to In Review succeeds (200) and their Approve attempt is denied (403) naming the actual rule. The View-level Couple member's Approve attempt is denied (403). The Comment-level Couple member's Approve attempt succeeds (200), leaving the plan version APPROVED. The owner can reopen for review and re-approve.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    let planVersionId = "";

    await test.step("Arrange: a complete, one-guest one-table plan (Draft)", async () => {
      await weddingData.createGuest(managedWedding.id, { firstName: "Ann", lastName: "Alpha" });
      await weddingData.createTable(managedWedding.id, { label: "Table 1", capacity: 1 });
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      expect(generated.status).toBe("DRAFT");
      planVersionId = generated.id;
    });

    // A manually-created `request.newContext()` (unlike the fixture-provided `request`/
    // `context.request`) doesn't inherit playwright.config.ts's own `baseURL` automatically, so
    // it's passed explicitly here.
    const baseURL = getEnv().APP_URL;
    const editContext = await playwrightRequest.newContext({ baseURL });
    const coupleViewContext = await playwrightRequest.newContext({ baseURL });
    const coupleCommentContext = await playwrightRequest.newContext({ baseURL });

    try {
      await test.step("Arrange: an Edit-level plain Collaborator, a View-level Couple member, and a Comment-level Couple member -- each its own independently-authenticated account", async () => {
        const editAccount = await signUpFreshAccount(editContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, editAccount.email, "EDIT", "COLLABORATOR");

        const coupleViewAccount = await signUpFreshAccount(coupleViewContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, coupleViewAccount.email, "VIEW", "COUPLE");

        const coupleCommentAccount = await signUpFreshAccount(coupleCommentContext, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, coupleCommentAccount.email, "COMMENT", "COUPLE");
      });

      await test.step("Act + Assert: the Edit Collaborator moves the plan to In Review (succeeds) then attempts to Approve it (denied)", async () => {
        const toReview = await editContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/status`,
          { data: { status: "IN_REVIEW" } },
        );
        expect(toReview.status()).toBe(200);

        const approveAttempt = await editContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/status`,
          { data: { status: "APPROVED" } },
        );
        expect(approveAttempt.status()).toBe(403);
        const body = (await approveAttempt.json()) as { error: string };
        expect(body.error).toBe(
          "Only the wedding's owner, or a Couple member with Comment or Edit access, can approve a plan.",
        );
      });

      await test.step("Assert: a Couple member left at View access is denied at Approve", async () => {
        const res = await coupleViewContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/status`,
          { data: { status: "APPROVED" } },
        );
        expect(res.status()).toBe(403);
      });

      await test.step("Act + Assert: a Couple member at Comment access succeeds at Approve", async () => {
        const res = await coupleCommentContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/status`,
          { data: { status: "APPROVED" } },
        );
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { planVersion: { status: string } };
        expect(body.planVersion.status).toBe("APPROVED");
      });

      await test.step("Assert: the wedding's own owner can always approve (reopen for review, then re-approve as the owner)", async () => {
        const reopen = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
        expect(reopen.status).toBe(200);
        const reapprove = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
        expect(reapprove.status).toBe(200);
        expect(reapprove.body.planVersion?.status).toBe("APPROVED");
      });
    } finally {
      await editContext.dispose();
      await coupleViewContext.dispose();
      await coupleCommentContext.dispose();
    }
  },
);
