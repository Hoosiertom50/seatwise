/**
 * TS-116 (REQ-COLLABORATION-NOTIFICATIONS) — the email invite is the one real way a new person
 * joins a wedding (FR-1.4a), and until now no test drove it: every collaborator was created with
 * the direct-grant setup shortcut (`addCollaborator`). This walks the whole thing through the UI:
 * the owner sends an invite from the Collaborators tab, the invitee opens the emailed link while
 * signed out, creates an account from it, lands back on the invite (TS-122), confirms their email
 * address from the link emailed at sign-up (TS-164 -- accepting is refused until then), accepts, and is in
 * the wedding at exactly the invited role and level. Then the same link, reopened, reveals nothing.
 *
 * A second invitee who already has an account signs in from the link instead, and is returned to
 * the invite the same way.
 *
 * The invite's token never leaves the server except in the email, so the test reads it from the
 * local database (e2e/support/testDatabase.ts).
 */

import { randomBytes } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { InviteAcceptPage } from "../pages/InviteAcceptPage.js";
import { SignupPage } from "../pages/SignupPage.js";
import { LoginPage } from "../pages/LoginPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueToken } from "../data/ids.js";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { confirmTestAccountEmail, inviteToken, plantEmailVerificationToken } from "../support/testDatabase.js";
import { VerifyEmailPage } from "../pages/VerifyEmailPage.js";

defineQualityTest(
  {
    id: "collaboration.invite-by-email-is-how-a-new-person-joins.send-sign-up-accept-and-sign-in",
    title: "an owner's email invite lets a signed-out person create an account or sign in from the link, come straight back, accept, and join at exactly the invited role and level",
    objective:
      "Confirms the full invite flow through the UI: sending from the Collaborators tab lists the invite as pending; the signed-out invite page names the wedding, role and level and offers sign-up and sign-in that both return to the invite; accepting joins the wedding at the invited level and role; and the accepted link, reopened, shows only that it was accepted.",
    expectedOutcome:
      "The owner sees 'Invite sent to <email>.' and a Pending row. The invitee's page names the wedding with 'comment access'; after creating an account they are back on the invite and Accept takes them into the wedding showing 'Your access: Comment'. The owner then sees them under People with access and no pending row. Reopening the link says 'already been accepted' without the wedding's name. A second, existing account signs in from its invite link and is returned to the invite with an Accept button, and after accepting holds the Couple role at Edit.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser }, testInfo) => {
    const collaboratorsTab = new CollaboratorsTabPage(page);
    const newPersonEmail = `pw-invitee-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
    let inviteId = "";
    let token = "";

    await test.step("Owner sends a Comment-level invite from the Collaborators tab", async () => {
      await collaboratorsTab.goto(managedWedding.id);
      await collaboratorsTab.sendInvite(newPersonEmail, "Comment");
      await expect(collaboratorsTab.inviteSentMessage(newPersonEmail)).toBeVisible();
      await expect(collaboratorsTab.pendingInvite(newPersonEmail)).toContainText("Collaborator · Comment · Pending");

      const [invite] = (await weddingData.listInvites(managedWedding.id)).filter((i) => i.email === newPersonEmail);
      expect(invite).toMatchObject({ status: "PENDING", permissionLevel: "COMMENT", role: "COLLABORATOR" });
      inviteId = invite.id;
      token = await inviteToken(inviteId);
    });

    const invitee = await browser.newContext();
    try {
      const inviteePage = await invitee.newPage();
      const invitePage = new InviteAcceptPage(inviteePage);

      await test.step("Signed out, the link names the wedding, role and level (not the invited address), and offers sign-up or sign-in", async () => {
        await invitePage.goto(token);
        await expect(invitePage.invitationSummary()).toContainText(managedWedding.name);
        await expect(invitePage.invitationSummary()).toContainText("a collaborator, with comment access");
        // TS-154 #4: a signed-out visitor isn't told which address the invite was for.
        await expect(invitePage.signInPrompt()).toContainText("the email address this invite was sent to");
        await expect(inviteePage.getByText(newPersonEmail)).toHaveCount(0);
        await expect(invitePage.acceptButton()).toHaveCount(0);
      });

      await test.step("Creating an account from the link comes straight back to the invite, and accepting joins the wedding", async () => {
        await invitePage.createAccountLink().click();
        // Generated for this test only, never logged or attached.
        await new SignupPage(inviteePage).signUp("Playwright Invitee", newPersonEmail, randomBytes(16).toString("base64url"));
        await expect(invitePage.acceptButton()).toBeVisible();
        // TS-164: a brand-new account confirms its email (the link emailed at sign-up) first.
        await invitePage.acceptButton().click();
        await expect(invitePage.acceptError()).toContainText("Confirm your email address to accept this invite");
        const verify = new VerifyEmailPage(inviteePage);
        await expect(verify.reminderBanner()).toBeVisible();
        await verify.goto(await plantEmailVerificationToken(newPersonEmail));
        await verify.confirmButton().click();
        await expect(verify.confirmedMessage()).toBeVisible();
        await invitePage.goto(token);
        await invitePage.accept();
        await inviteePage.waitForURL(`**/weddings/${managedWedding.id}`);
        await expect(new WeddingDetailPage(inviteePage).yourAccessBadge()).toHaveText("Your access: Comment");
      });

      await test.step("The owner sees them under People with access, and the invite is no longer pending", async () => {
        await collaboratorsTab.goto(managedWedding.id);
        await expect(collaboratorsTab.person(newPersonEmail)).toBeVisible();
        await expect(collaboratorsTab.accessLevelSelect("Playwright Invitee")).toHaveValue("COMMENT");
        await expect(collaboratorsTab.pendingInvite(newPersonEmail)).toHaveCount(0);
        const collaborators = await weddingData.listCollaborators(managedWedding.id);
        expect(collaborators.find((c) => c.userEmail === newPersonEmail)).toMatchObject({ permissionLevel: "COMMENT", role: "COLLABORATOR" });
      });

      await test.step("The accepted link, reopened, says only that it was accepted", async () => {
        await invitePage.goto(token);
        await expect(invitePage.stateMessage("ACCEPTED")).toBeVisible();
        await expect(invitePage.textLocator(managedWedding.name)).toHaveCount(0);
      });
    } finally {
      await invitee.close();
    }

    await test.step("Someone with an account signs in from the link, comes straight back, and joins as Couple at Edit", async () => {
      const existing = await browser.newContext();
      try {
        const email = `pw-existing-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`;
        const password = randomBytes(16).toString("base64url");
        expect((await existing.request.post("/api/v1/auth/signup", { data: { name: "Playwright Existing", email, password } })).status()).toBe(201);
        // TS-164: an existing account has confirmed its email long since.
        await confirmTestAccountEmail(email);
        await existing.clearCookies();

        const created = await weddingData.createInvite(managedWedding.id, email, "EDIT", "COUPLE");
        expect(created.status).toBe(201);
        const existingPage = await existing.newPage();
        const invitePage = new InviteAcceptPage(existingPage);
        await invitePage.goto(await inviteToken(created.body.invite!.id));
        await invitePage.logInLink().click();
        await new LoginPage(existingPage).login(email, password);
        await expect(invitePage.acceptButton()).toBeVisible();
        await expect(invitePage.invitationSummary()).toContainText("a Couple member, with edit access");
        await invitePage.accept();
        await existingPage.waitForURL(`**/weddings/${managedWedding.id}`);
        await expect(new WeddingDetailPage(existingPage).yourAccessBadge()).toHaveText("Your access: Edit");

        const collaborators = await weddingData.listCollaborators(managedWedding.id);
        expect(collaborators.find((c) => c.userEmail === email)).toMatchObject({ permissionLevel: "EDIT", role: "COUPLE" });
      } finally {
        await existing.close();
      }
    });
  },
);
