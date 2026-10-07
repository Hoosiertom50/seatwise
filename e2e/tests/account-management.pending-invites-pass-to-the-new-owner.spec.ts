/**
 * TS-204 (REQ-ACCOUNT-WEDDING-MANAGEMENT, Tom's decision) — invites still pending when a wedding is
 * handed off stay pending, and they're the new owner's to see and cancel; the old owner (now an
 * Edit collaborator) can no longer manage them.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDataSetup } from "../data/api.js";
import { uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "account-management.pending-invites-pass-to-the-new-owner.hand-off-then-new-owner-revokes",
    title: "a pending invite survives a hand-off, and the new owner can see and cancel it while the old owner can't",
    objective:
      "Confirms (TS-204, Tom's decision) that an invite the owner sent and nobody has answered is still pending after the owner hands the wedding to a collaborator; that the new owner sees it in the wedding's invites and can cancel it; and that the old owner, now an Edit collaborator, can neither list nor cancel invites.",
    expectedOutcome:
      "After the hand-off the new owner's invite list has the invite as PENDING; the old owner's GET and DELETE on invites answer 403; the new owner's DELETE answers 200 and the invite then reads REVOKED.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const invitedEmail = `pw-tester-invitee-${uniqueToken(testInfo.workerIndex)}@example.invalid`;
    const newOwner = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "newowner");

    try {
      const invite = await test.step("Arrange: an unanswered invite, and a collaborator to hand the wedding to", async () => {
        const sent = await weddingData.createInvite(w, invitedEmail, "COMMENT");
        expect(sent.status, JSON.stringify(sent.body)).toBe(201);
        await weddingData.addCollaborator(w, newOwner.email, "EDIT");
        return sent.body.invite!;
      });

      await test.step("Act: the owner hands the wedding off", async () => {
        const collaborator = (await weddingData.listCollaborators(w)).find((c) => c.userEmail === newOwner.email)!;
        const res = await context.request.post(`/api/v1/weddings/${w}/transfer-ownership`, { data: { collaboratorId: collaborator.id } });
        expect(res.status(), await res.text()).toBe(200);
      });

      await test.step("The invite is still pending, and it's the new owner's to manage", async () => {
        const asNewOwner = new WeddingDataSetup(newOwner.context.request);
        const listed = (await asNewOwner.listInvites(w)).find((i) => i.id === invite.id);
        expect(listed?.status).toBe("PENDING");

        expect((await context.request.get(`/api/v1/weddings/${w}/invites`)).status()).toBe(403);
        expect((await weddingData.revokeInvite(w, invite.id)).status).toBe(403);

        expect((await asNewOwner.revokeInvite(w, invite.id)).status).toBe(200);
        expect((await asNewOwner.listInvites(w)).find((i) => i.id === invite.id)?.status).toBe("REVOKED");
      });

      await test.step("Clean up: the new owner deletes the wedding", async () => {
        const res = await newOwner.context.request.delete(`/api/v1/weddings/${w}`);
        expect([200, 404]).toContain(res.status());
      });
    } finally {
      await newOwner.context.close();
    }
  },
);
