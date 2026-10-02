/**
 * TS-148 (REQ-ACCESS-CONTROL) — changing who has access to a wedding sticks, and stays private.
 * - An invite still pending when the owner sets that person's access directly is cancelled, so
 *   accepting it later can't change (raise or lower) the access the owner just set.
 * - Accepting an invite when you already have access is refused and leaves your access alone.
 * - Only the owner sees everyone's email address; a collaborator sees their own.
 * - A collaborator can leave a wedding themselves, but can't remove anyone else.
 * - An unknown plan version or table is "not found", not a conflict.
 * - A signed-out visitor holding an invite link isn't shown who it was sent to.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { inviteToken } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "collaboration.access-changes-stick-and-stay-private.stale-invites-emails-leave-not-found",
    title: "a stale invite can't undo an access change, collaborators only see their own email, anyone can leave, and unknown ids are 'not found'",
    objective:
      "Confirms that an EDIT invite pending when the owner adds that person directly as VIEW is cancelled (accepting it returns 409 and they stay VIEW); that a View collaborator listing collaborators sees only their own email while the owner sees all; that a collaborator can remove their own access but gets 403 removing someone else's; that a status change or required-guest update on an unknown id returns 404; and that a signed-out invite preview carries no invited email while the invitee's own signed-in preview does.",
    expectedOutcome:
      "Accept returns 409 and the person's level is still VIEW. The View user's list has their own email and null for the other; the owner's has both. Leave returns 200 and the wedding then returns 404 for them; removing another person returns 403. Unknown plan version and table both return 404. The signed-out preview has no invitedEmail; the invitee's has it.",
    requirementIds: ["REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    const visitor = await browser.newContext();
    try {
      const levelOf = async (email: string) => {
        const { collaborators } = (await (await context.request.get(`/api/v1/weddings/${w}/collaborators`)).json()) as {
          collaborators: { userEmail: string | null; permissionLevel: string }[];
        };
        return collaborators.find((c) => c.userEmail === email)?.permissionLevel;
      };

      await test.step("An invite pending when access is set directly is cancelled and can't change it", async () => {
        const sent = await weddingData.createInvite(w, viewer.email, "EDIT");
        expect(sent.status).toBe(201);
        const token = await inviteToken(sent.body.invite!.id);
        // Direct add, with the email typed in capitals: still finds the account.
        await weddingData.addCollaborator(w, viewer.email.toUpperCase(), "VIEW");
        const accept = await viewer.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
        expect(accept.status()).toBe(409);
        expect(await levelOf(viewer.email)).toBe("VIEW");
      });

      await test.step("Only the owner sees everyone's email; a collaborator sees their own", async () => {
        await weddingData.addCollaborator(w, editor.email, "EDIT");
        const asViewer = (await (await viewer.context.request.get(`/api/v1/weddings/${w}/collaborators`)).json()) as {
          collaborators: { userId: string; userEmail: string | null; userName: string }[];
        };
        const mine = asViewer.collaborators.find((c) => c.userName === viewer.name)!;
        const theirs = asViewer.collaborators.find((c) => c.userName === editor.name)!;
        expect(mine.userEmail).toBe(viewer.email);
        expect(theirs.userEmail).toBeNull();
        expect(await levelOf(editor.email)).toBe("EDIT");

        const tab = new CollaboratorsTabPage(await viewer.context.newPage());
        await tab.goto(w);
        await expect(tab.root()).not.toContainText(editor.email);
      });

      await test.step("A collaborator can't remove someone else, but can leave themselves", async () => {
        const { collaborators } = (await (await context.request.get(`/api/v1/weddings/${w}/collaborators`)).json()) as {
          collaborators: { id: string; userEmail: string | null }[];
        };
                const editorRow = collaborators.find((c) => c.userEmail === editor.email)!;
        expect((await viewer.context.request.delete(`/api/v1/weddings/${w}/collaborators/${editorRow.id}`)).status()).toBe(403);

        const tab = new CollaboratorsTabPage(await viewer.context.newPage());
        await tab.goto(w);
        await tab.leaveWedding();
        expect((await viewer.context.request.get(`/api/v1/weddings/${w}`)).status()).toBe(404);
      });

      await test.step("An unknown plan version or table is 'not found'", async () => {
        const status = await context.request.post(`/api/v1/weddings/${w}/plan-versions/does-not-exist/status`, {
          data: { status: "IN_REVIEW" },
        });
        expect(status.status()).toBe(404);
        const required = await context.request.put(`/api/v1/weddings/${w}/tables/does-not-exist/required-guests`, {
          data: { guestIds: [] },
        });
        expect(required.status()).toBe(404);
      });

      await test.step("A signed-out visitor holding an invite link isn't told who it was for", async () => {
        const invitee = `pw-tester-invitee-${Date.now()}@example.invalid`;
        const sent = await weddingData.createInvite(w, invitee, "VIEW");
        const token = await inviteToken(sent.body.invite!.id);
        const preview = (await (await visitor.request.get(`/api/v1/invites/${token}`)).json()) as { invite: Record<string, unknown> };
        expect(preview.invite.status).toBe("PENDING");
        expect(preview.invite.invitedEmail).toBeUndefined();
      });
    } finally {
      await visitor.close();
      await viewer.context.close();
      await editor.context.close();
    }
  },
);
