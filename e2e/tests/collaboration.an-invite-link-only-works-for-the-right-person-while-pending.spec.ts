/**
 * TS-116 (REQ-COLLABORATION-NOTIFICATIONS) — an invite link is a key to a wedding, so every way it
 * should refuse is checked here (FR-1.4a, packages/db/src/queries/invites.ts):
 *
 * - signed in as someone else: the page shows only that the address doesn't match, and accepting
 *   through the API is refused (403) -- the invite stays pending for the right person;
 * - revoked by the owner (from the Collaborators tab), expired after 7 days, or made up: the page
 *   shows only that status, never the wedding's name, and accepting is refused;
 * - the owner's rules: the address is normalised (case, spaces); the owner themself and an existing
 *   collaborator can't be invited; re-inviting an address replaces its pending invite (the old
 *   link stops working); and an invite that's already resolved can't be revoked.
 *
 * Tokens and expiry are reached in the local database (e2e/support/testDatabase.ts).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { InviteAcceptPage } from "../pages/InviteAcceptPage.js";
import { uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext, TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { expireInvite, inviteToken } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "collaboration.an-invite-link-only-works-for-the-right-person-while-pending.mismatch-revoked-expired-rules",
    title: "an invite link refuses the wrong account, and a revoked, expired or made-up link, without revealing the wedding -- and the owner's invite rules hold",
    objective:
      "Confirms that an invite can only be accepted by the invited address while it is pending: another signed-in account is shown a mismatch and refused; revoking from the Collaborators tab, expiry, and an unknown token each show only their status and refuse acceptance; and the invite rules (address normalised, owner and existing collaborators refused, re-invite supersedes, resolved invites can't be revoked) are enforced.",
    expectedOutcome:
      "Mismatch: page shows the different-address message with no wedding name, accept returns 403 and the invite stays Pending. Revoked: the row leaves the owner's list, the page says revoked, accept returns 409. Expired: the owner's row says Expired, the page says expired, accept returns 409. Unknown token: 'doesn't exist'. Rules: a mixed-case, padded address is stored lowercased; inviting the owner or a current collaborator returns 409; re-inviting marks the first invite Revoked; revoking an accepted invite returns 404.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, account, page, browser }, testInfo) => {
    const collaboratorsTab = new CollaboratorsTabPage(page);
    const someoneElse = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "someone-else");
    const invitedEmail = `pw-invited-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;

    try {
      const otherPage = await someoneElse.context.newPage();
      const invitePage = new InviteAcceptPage(otherPage);

      const sent = await weddingData.createInvite(managedWedding.id, invitedEmail, "EDIT");
      expect(sent.status).toBe(201);
      const inviteId = sent.body.invite!.id;
      const token = await inviteToken(inviteId);

      await test.step("Signed in as a different account: a mismatch notice only, and accepting is refused", async () => {
        await invitePage.goto(token);
        await expect(invitePage.stateMessage("MISMATCHED_ACCOUNT")).toBeVisible();
        await expect(invitePage.textLocator(managedWedding.name)).toHaveCount(0);
        await expect(invitePage.acceptButton()).toHaveCount(0);

        const accept = await someoneElse.context.request.post(`/api/v1/invites/${token}/accept`);
        expect(accept.status()).toBe(403);
        expect((await weddingData.listInvites(managedWedding.id)).find((i) => i.id === inviteId)?.status).toBe("PENDING");
        expect((await weddingData.listCollaborators(managedWedding.id)).some((c) => c.userEmail === someoneElse.email)).toBe(false);
      });

      await test.step("Revoked from the Collaborators tab: the row goes, the link says revoked, accepting is refused", async () => {
        await collaboratorsTab.goto(managedWedding.id);
        await collaboratorsTab.revokeInvite(invitedEmail);
        await expect(collaboratorsTab.pendingInvite(invitedEmail)).toHaveCount(0);
        expect((await weddingData.listInvites(managedWedding.id)).find((i) => i.id === inviteId)?.status).toBe("REVOKED");

        await invitePage.goto(token);
        await expect(invitePage.stateMessage("REVOKED")).toBeVisible();
        await expect(invitePage.textLocator(managedWedding.name)).toHaveCount(0);
        expect((await someoneElse.context.request.post(`/api/v1/invites/${token}/accept`)).status()).toBe(409);
      });

      await test.step("Expired after 7 days: the owner sees Expired, the link says expired, accepting is refused", async () => {
        const again = await weddingData.createInvite(managedWedding.id, someoneElse.email, "VIEW");
        expect(again.status).toBe(201);
        const expiringId = again.body.invite!.id;
        await expireInvite(expiringId);

        await collaboratorsTab.goto(managedWedding.id);
        await expect(collaboratorsTab.pendingInvite(someoneElse.email)).toContainText("Expired");
        const expiringToken = await inviteToken(expiringId);
        await invitePage.goto(expiringToken);
        await expect(invitePage.stateMessage("EXPIRED")).toBeVisible();
        await expect(invitePage.textLocator(managedWedding.name)).toHaveCount(0);
        // The right person, signed in -- still refused once expired.
        expect((await someoneElse.context.request.post(`/api/v1/invites/${expiringToken}/accept`)).status()).toBe(409);
        expect((await weddingData.listCollaborators(managedWedding.id)).some((c) => c.userEmail === someoneElse.email)).toBe(false);
      });

      await test.step("A made-up link says it doesn't exist", async () => {
        await invitePage.goto("0".repeat(64));
        await expect(invitePage.stateMessage("NOT_FOUND")).toBeVisible();
      });

      await test.step("Rules: address normalised, owner and current collaborators refused, re-invite supersedes, resolved can't be revoked", async () => {
        const padded = `  PW-Mixed-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN.toUpperCase()}  `;
        const normalised = await weddingData.createInvite(managedWedding.id, padded, "VIEW");
        expect(normalised.status).toBe(201);
        expect(normalised.body.invite!.email).toBe(padded.trim().toLowerCase());

        const owner = await weddingData.createInvite(managedWedding.id, account.email.toUpperCase(), "EDIT");
        expect(owner.status).toBe(409);
        expect(owner.body.error).toContain("already owns this wedding");

        await weddingData.addCollaborator(managedWedding.id, someoneElse.email, "VIEW");
        const existing = await weddingData.createInvite(managedWedding.id, someoneElse.email, "EDIT");
        expect(existing.status).toBe(409);
        expect(existing.body.error).toContain("already a collaborator");

        const reinviteEmail = `pw-reinvite-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
        const first = await weddingData.createInvite(managedWedding.id, reinviteEmail, "VIEW");
        const second = await weddingData.createInvite(managedWedding.id, reinviteEmail, "EDIT");
        const invites = await weddingData.listInvites(managedWedding.id);
        expect(invites.find((i) => i.id === first.body.invite!.id)?.status).toBe("REVOKED");
        expect(invites.find((i) => i.id === second.body.invite!.id)?.status).toBe("PENDING");
        await invitePage.goto(await inviteToken(first.body.invite!.id));
        await expect(invitePage.stateMessage("REVOKED")).toBeVisible();

        const revokeResolved = await weddingData.revokeInvite(managedWedding.id, first.body.invite!.id);
        expect(revokeResolved.status).toBe(404);
        expect(revokeResolved.body.error).toContain("already resolved");
      });
    } finally {
      await someoneElse.context.close();
    }
  },
);
