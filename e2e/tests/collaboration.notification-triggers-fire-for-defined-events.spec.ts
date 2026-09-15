/**
 * TS-48 (REQ-COLLABORATION-NOTIFICATIONS) — converts AC-070 ("Defined notification triggers fire
 * correctly").
 *
 * Confirmed directly in packages/db/src/queries/notifications.ts's `notifyWeddingCollaborators`
 * (fans an in-app row out to the wedding's owner + every collaborator, excluding whoever caused
 * the event, and additionally attempts an email per-recipient only if the wedding's
 * `emailNotificationsEnabled` flag is on) and its 6 call sites across plan-versions.ts,
 * comments.ts, and the guest routes. This test drives every one of the AC's own three steps
 * ("share a plan," "reply to a comment," "after approval, change a table/guest/attendance/status")
 * against the actual `NotificationType` values that exist (PLAN_SHARED, COMMENT_REPLY,
 * TABLE_CHANGED, GUEST_ADDED, GUEST_REMOVED, ATTENDANCE_CHANGED, STATUS_CHANGED), confirms a
 * *top-level* comment does NOT notify (only a reply does), confirms the real "post-approval only"
 * gating that TABLE_CHANGED/GUEST_ADDED/GUEST_REMOVED/ATTENDANCE_CHANGED all share (a Draft
 * plan's own constant churn would otherwise spam every collaborator), and confirms the
 * `emailNotificationsEnabled` toggle affects only the (unobservable, see below) email attempt --
 * never the in-app notification or the underlying action, which both succeed identically either
 * way.
 *
 * Real scope boundary (documented, not silently assumed): `sendEmailNotification` is a stub in
 * this sandbox (no RESEND_API_KEY configured) that only `console.log`s -- confirmed directly in
 * notifications.ts, and already established by the near-identical
 * plan-review.collaborator-permission-levels-gate-edits-and-notify.spec.ts (TS-43). There is no
 * test-mode inbox/capture mechanism anywhere in this codebase (grepped for
 * sendMail/nodemailer/resend/inbox), so an actual email being sent (or not) is not independently
 * observable here. What IS directly testable, and asserted below, is the in-app half of every
 * trigger, plus the fact that toggling email off changes nothing about the action's own success
 * or the in-app notification's own delivery.
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";
import { uniquePersonName } from "../data/ids.js";

interface NotificationRow {
  type: string;
  message: string;
}

async function notifications(ctx: { get: (url: string) => Promise<{ json(): Promise<unknown> }> }) {
  const res = await ctx.get("/api/v1/notifications");
  const body = (await res.json()) as { notifications: NotificationRow[] };
  return body.notifications;
}

defineQualityTest(
  {
    id: "collaboration.notification-triggers-fire-for-defined-events.share-reply-and-post-approval-changes-notify-the-right-recipient",
    title: "sharing a plan, replying to a comment, and post-approval table/guest/attendance/status changes each notify the right collaborator in-app; a top-level comment and any pre-approval change notify no one; and disabling email never blocks the action or the in-app notification",
    objective:
      "Confirms PLAN_SHARED fires on share-for-review, COMMENT_REPLY fires only on a reply (never a top-level comment) and goes to the other party, and TABLE_CHANGED/GUEST_ADDED/GUEST_REMOVED/ATTENDANCE_CHANGED/STATUS_CHANGED all fire correctly for their respective post-approval actions -- while the same table-change action taken before approval notifies no one. Also confirms disabling a wedding's emailNotificationsEnabled setting leaves both the action's own success and its in-app notification completely unaffected.",
    expectedOutcome:
      "Each trigger produces exactly the expected NotificationType and message for its recipient (the party who did NOT perform the action). A top-level comment and a pre-approval table move produce no new notification. After emailNotificationsEnabled is turned off, a further status change still returns 200 and still produces a new in-app STATUS_CHANGED notification.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let planVersionId = "";
    let guestAId = "";
    let guestAName = "";
    let guestBId = "";
    let guestBName = "";
    let tableAId = "";
    let tableCId = "";
    let tableCLabel = "";

    await test.step("Arrange: two guests, three tables (one left empty for a later move), and a complete generated plan", async () => {
      const guestA = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestAId = guestA.id;
      guestAName = `${guestA.firstName} ${guestA.lastName}`;
      const guestB = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestBId = guestB.id;
      guestBName = `${guestB.firstName} ${guestB.lastName}`;

      const tableA = await weddingData.createTable(managedWedding.id, { label: "Table A", capacity: 2 });
      await weddingData.createTable(managedWedding.id, { label: "Table B", capacity: 2 });
      const tableC = await weddingData.createTable(managedWedding.id, { label: "Table C", capacity: 1 });
      tableAId = tableA.id;
      tableCId = tableC.id;
      tableCLabel = tableC.label;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      planVersionId = generated.id;
    });

    const baseURL = getEnv().APP_URL;
    const collabCtx = await playwrightRequest.newContext({ baseURL });
    try {
      await test.step("Arrange: an Edit-level collaborator", async () => {
        const collabAccount = await signUpFreshAccount(collabCtx, testInfo.workerIndex);
        await weddingData.addCollaborator(managedWedding.id, collabAccount.email, "EDIT");
      });

      await test.step("Act + Assert: sharing the plan for review notifies the collaborator (PLAN_SHARED), not the owner who shared it", async () => {
        const res = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "IN_REVIEW");
        expect(res.status).toBe(200);

        const collabNotifs = await notifications(collabCtx);
        const match = collabNotifs.find((n) => n.type === "PLAN_SHARED");
        expect(match).toBeTruthy();
        expect(match!.message).toBe("The seating plan was shared for review.");

        const ownerNotifs = await notifications(context.request);
        expect(ownerNotifs.find((n) => n.type === "PLAN_SHARED")).toBeFalsy();
      });

      let commentId = "";
      await test.step("Act + Assert: a top-level comment (the owner, on guestA) notifies no one", async () => {
        const before = await notifications(collabCtx);
        const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/comments`, {
          data: { targetType: "GUEST", guestId: guestAId, body: "Is this seat confirmed?" },
        });
        expect(res.status()).toBe(201);
        commentId = ((await res.json()) as { comment: { id: string } }).comment.id;

        const after = await notifications(collabCtx);
        expect(after.filter((n) => n.type === "COMMENT_REPLY")).toHaveLength(
          before.filter((n) => n.type === "COMMENT_REPLY").length,
        );
      });

      await test.step("Act + Assert: the collaborator replying to that comment notifies the owner (COMMENT_REPLY), the other party -- not the replier", async () => {
        const res = await collabCtx.post(`/api/v1/weddings/${managedWedding.id}/comments`, {
          data: { targetType: "GUEST", guestId: guestAId, body: "Yes, confirmed this morning.", parentCommentId: commentId },
        });
        expect(res.status()).toBe(201);

        const ownerNotifs = await notifications(context.request);
        const match = ownerNotifs.find((n) => n.type === "COMMENT_REPLY");
        expect(match).toBeTruthy();
        expect(match!.message).toContain(`New reply on "Guest: ${guestAName}"`);
        expect(match!.message).toContain("Yes, confirmed this morning.");

        const collabNotifs = await notifications(collabCtx);
        expect(collabNotifs.find((n) => n.type === "COMMENT_REPLY" && n.message.includes("Yes, confirmed"))).toBeFalsy();
      });

      await test.step("Act + Assert: approving the plan notifies the collaborator (STATUS_CHANGED)", async () => {
        const res = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
        expect(res.status).toBe(200);

        const collabNotifs = await notifications(collabCtx);
        const match = collabNotifs.find((n) => n.type === "STATUS_CHANGED" && n.message.includes("APPROVED"));
        expect(match).toBeTruthy();
        expect(match!.message).toBe("The seating plan status changed to APPROVED.");
      });

      await test.step("Act + Assert: a post-approval manual move notifies the collaborator (TABLE_CHANGED)", async () => {
        const res = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestAId, tableCId);
        expect(res.status).toBe(200);

        const collabNotifs = await notifications(collabCtx);
        const match = collabNotifs.find((n) => n.type === "TABLE_CHANGED");
        expect(match).toBeTruthy();
        expect(match!.message).toBe(`${guestAName} moved to "${tableCLabel}".`);
      });

      let guestCId = "";
      let guestCName = "";
      await test.step("Act + Assert: the collaborator adding a guest post-approval notifies the owner (GUEST_ADDED)", async () => {
        const guestC = uniquePersonName(testInfo.workerIndex);
        guestCName = `${guestC.firstName} ${guestC.lastName}`;
        const res = await collabCtx.post(`/api/v1/weddings/${managedWedding.id}/guests`, { data: guestC });
        expect(res.status()).toBe(201);
        guestCId = ((await res.json()) as { guest: { id: string } }).guest.id;

        const ownerNotifs = await notifications(context.request);
        const match = ownerNotifs.find((n) => n.type === "GUEST_ADDED");
        expect(match).toBeTruthy();
        expect(match!.message).toBe(`${guestCName} was added to the guest list.`);
      });

      await test.step("Act + Assert: the owner removing that guest post-approval notifies the collaborator (GUEST_REMOVED)", async () => {
        const res = await context.request.delete(`/api/v1/weddings/${managedWedding.id}/guests/${guestCId}`);
        expect(res.status()).toBe(200);

        const collabNotifs = await notifications(collabCtx);
        const match = collabNotifs.find((n) => n.type === "GUEST_REMOVED");
        expect(match).toBeTruthy();
        expect(match!.message).toBe(`${guestCName} was removed from the guest list.`);
      });

      await test.step("Act + Assert: the collaborator marking guestB not-attending post-approval notifies the owner (ATTENDANCE_CHANGED)", async () => {
        const res = await collabCtx.post(`/api/v1/weddings/${managedWedding.id}/guests/${guestBId}/attendance`, {
          data: { attendance: "NOT_ATTENDING" },
        });
        expect(res.status()).toBe(200);

        const ownerNotifs = await notifications(context.request);
        const match = ownerNotifs.find((n) => n.type === "ATTENDANCE_CHANGED");
        expect(match).toBeTruthy();
        expect(match!.message).toBe(`${guestBName} was marked not attending.`);
      });

      await test.step("Act + Assert: moving the plan back to Draft notifies the collaborator too (STATUS_CHANGED), then a Draft-stage move notifies no one (post-approval-only gating)", async () => {
        const toDraft = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "DRAFT");
        expect(toDraft.status).toBe(200);
        const collabNotifsAfterDraft = await notifications(collabCtx);
        expect(collabNotifsAfterDraft.find((n) => n.type === "STATUS_CHANGED" && n.message.includes("DRAFT"))).toBeTruthy();

        const beforeCount = collabNotifsAfterDraft.filter((n) => n.type === "TABLE_CHANGED").length;
        const move = await weddingData.moveGuestAssignment(managedWedding.id, planVersionId, guestAId, tableAId);
        expect(move.status).toBe(200);

        const afterCount = (await notifications(collabCtx)).filter((n) => n.type === "TABLE_CHANGED").length;
        expect(afterCount, "a Draft-stage move should not add a new TABLE_CHANGED notification").toBe(beforeCount);
      });

      await test.step("Act + Assert: disabling email notifications for the wedding still lets the action succeed and still delivers the in-app notification", async () => {
        const settingsRes = await context.request.patch(
          `/api/v1/weddings/${managedWedding.id}/notification-settings`,
          { data: { emailNotificationsEnabled: false } },
        );
        expect(settingsRes.status()).toBe(200);

        const beforeCount = (await notifications(collabCtx)).filter(
          (n) => n.type === "STATUS_CHANGED" && n.message.includes("APPROVED"),
        ).length;

        const reApprove = await weddingData.setPlanVersionStatus(managedWedding.id, planVersionId, "APPROVED");
        expect(reApprove.status).toBe(200);

        const afterCount = (await notifications(collabCtx)).filter(
          (n) => n.type === "STATUS_CHANGED" && n.message.includes("APPROVED"),
        ).length;
        expect(afterCount, "the in-app notification must still be delivered with email notifications disabled").toBe(
          beforeCount + 1,
        );
      });
    } finally {
      await collabCtx.dispose();
    }
  },
);
