/**
 * TS-213 / TS-203 (REQ-COLLABORATION-NOTIFICATIONS, REQ-NON-FUNCTIONAL) — notification emails each
 * member can turn off, and the email budgets other people depend on.
 * - Every member has their own "Email me about this wedding" switch on the Collaborators tab (a
 *   collaborator on their own row, the owner in the wedding's settings). Off means in-app
 *   notifications only; the others are still emailed. Before, only the owner could turn emails
 *   off, and only for everyone.
 * - A hand-off tells the new owner (Tom's decision), and each person's switch goes with them.
 * - Accepting an invite whose email went out confirms the account's address (the link only reached
 *   that inbox); one whose link the owner copied doesn't (authentication.new-accounts-confirm-their-email).
 * Tests here run with emails only logged, so who was emailed is read from the per-wedding count of
 * notification emails (one per person emailed). The email's own footer ("why you're getting this,
 * how to stop it"), the rolling 24-hour counts across midnight UTC, the IPv6 /48 count and one
 * account's share of the day's email are unit-tested (email-budgets.test.mts).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueTitle } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import {
  inviteToken,
  inviteWasEmailed,
  testAccountEmailConfirmed,
  weddingNotificationEmailsThisHour,
} from "../support/testDatabase.js";

interface NotificationRow {
  type: string;
  message: string;
}

defineQualityTest(
  {
    id: "cross-cutting.email-budgets-and-member-email-settings.member-turns-off-emails",
    title: "a member who turns off 'Email me about this wedding' still gets in-app notifications but no emails, while the others are still emailed; the owner has the same switch",
    objective:
      "Confirms that a View-access collaborator sees 'Email me about this wedding' checked on their own row of the Collaborators tab, that unchecking it is saved (still unchecked after a reload, and in the API), that a guest's RSVP then emails only the owner while both get the in-app notification, and that once the owner also turns their own switch off (in the wedding's settings) the next RSVP emails no one -- still notifying both in the app.",
    expectedOutcome:
      "First RSVP with both switches on: 2 notification emails counted. Collaborator's checkbox unchecked after a reload; the API reports myEmailNotificationsEnabled false. Second RSVP: 1 more email (the owner's), and the collaborator has 2 RSVP_RECEIVED notifications. Owner unchecks theirs: third RSVP adds no email, and the owner has 3 RSVP_RECEIVED notifications.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page, browser, playwright }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const baseURL = testInfo.project.use.baseURL;
    const aunt = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "aunt");
    await weddingData.addCollaborator(w, aunt.email, "VIEW");

    // A guest answers their own RSVP link (a fresh guest each time -- one guest's answers are
    // emailed at most once an hour).
    const guestAnswers = async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      try {
        expect((await visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "CONFIRMED", headcount: 1 } })).status()).toBe(200);
      } finally {
        await visitor.dispose();
      }
    };
    const rsvpNotifications = async (request: typeof context.request) =>
      ((await (await request.get("/api/v1/notifications")).json()) as { notifications: NotificationRow[] }).notifications.filter(
        (n) => n.type === "RSVP_RECEIVED",
      ).length;

    try {
      await test.step("With both switches on, a guest's RSVP emails both of them", async () => {
        const before = await weddingNotificationEmailsThisHour(w);
        await guestAnswers();
        expect(await weddingNotificationEmailsThisHour(w)).toBe(before + 2);
      });

      await test.step("The collaborator turns off emails on their own row, and it stays off", async () => {
        const auntPage = await aunt.context.newPage();
        const tab = new CollaboratorsTabPage(auntPage);
        await tab.goto(w);
        await expect(tab.myEmailsCheckbox()).toBeChecked();
        await tab.myEmailsCheckbox().uncheck();
        await expect
          .poll(async () =>
            ((await (await aunt.context.request.get(`/api/v1/weddings/${w}/notification-settings`)).json()) as { myEmailNotificationsEnabled: boolean })
              .myEmailNotificationsEnabled,
          )
          .toBe(false);
        await auntPage.reload();
        await tab.goto(w);
        await expect(tab.myEmailsCheckbox()).not.toBeChecked();
        // The owner's own switch is untouched.
        const owner = (await (await context.request.get(`/api/v1/weddings/${w}/notification-settings`)).json()) as {
          myEmailNotificationsEnabled: boolean;
        };
        expect(owner.myEmailNotificationsEnabled).toBe(true);
      });

      await test.step("The next RSVP emails only the owner -- the collaborator still sees it in the app", async () => {
        const before = await weddingNotificationEmailsThisHour(w);
        await guestAnswers();
        expect(await weddingNotificationEmailsThisHour(w)).toBe(before + 1);
        expect(await rsvpNotifications(aunt.context.request)).toBe(2);
      });

      await test.step("The owner turns off their own emails in the wedding's settings: the next RSVP emails no one", async () => {
        const tab = new CollaboratorsTabPage(page);
        await tab.goto(w);
        await expect(tab.myEmailsCheckbox()).toBeChecked();
        await tab.myEmailsCheckbox().uncheck();
        await expect
          .poll(async () =>
            ((await (await context.request.get(`/api/v1/weddings/${w}/notification-settings`)).json()) as { myEmailNotificationsEnabled: boolean })
              .myEmailNotificationsEnabled,
          )
          .toBe(false);
        // The wedding-wide switch is a different one, and stays on.
        await expect(tab.emailNotificationsCheckbox()).toBeChecked();
        const before = await weddingNotificationEmailsThisHour(w);
        await guestAnswers();
        expect(await weddingNotificationEmailsThisHour(w)).toBe(before);
        expect(await rsvpNotifications(context.request)).toBe(3);
        expect(await rsvpNotifications(aunt.context.request)).toBe(3);
      });
    } finally {
      await aunt.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.email-budgets-and-member-email-settings.hand-off-tells-the-new-owner",
    title: "handing a wedding off tells the new owner, and each person's own email switch goes with them",
    objective:
      "Confirms (Tom's decision) that when the owner hands the wedding to a collaborator who had turned their emails off, the new owner gets an OWNERSHIP_TRANSFERRED notification naming the wedding, the previous owner doesn't, the new owner's switch is still off (now as the owner), and the previous owner's (on) moved to their new collaborator row.",
    expectedOutcome:
      "Hand-off returns 200. The new owner has one OWNERSHIP_TRANSFERRED notification containing the wedding's name and 'you're now its owner'; the previous owner has none. The new owner's myEmailNotificationsEnabled is false; the previous owner's is true.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ browser }, testInfo) => {
    // Two accounts of its own (like account-management.hand-off-weddings-then-delete-the-account):
    // after the hand-off the wedding belongs to the heir; the run's teardown removes it.
    const owner = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "giver");
    const heir = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "heir");
    const weddingName = uniqueTitle(testInfo.workerIndex, "Handoff Notice");
    type Request = typeof owner.context.request;
    try {
      const w = ((await (await owner.context.request.post("/api/v1/weddings", { data: { name: weddingName } })).json()) as {
        wedding: { id: string };
      }).wedding.id;
      const mine = async (request: Request) =>
        ((await (await request.get(`/api/v1/weddings/${w}/notification-settings`)).json()) as { myEmailNotificationsEnabled: boolean })
          .myEmailNotificationsEnabled;
      const handedOff = async (request: Request) =>
        ((await (await request.get("/api/v1/notifications")).json()) as { notifications: NotificationRow[] }).notifications.filter(
          (n) => n.type === "OWNERSHIP_TRANSFERRED",
        );
      const added = await owner.context.request.post(`/api/v1/weddings/${w}/collaborators`, {
        data: { email: heir.email, permissionLevel: "EDIT", role: "COLLABORATOR" },
      });
      expect(added.ok()).toBe(true);
      const collaboratorId = ((await added.json()) as { collaborator: { id: string } }).collaborator.id;
      expect(
        (await heir.context.request.patch(`/api/v1/weddings/${w}/notification-settings`, { data: { myEmailNotificationsEnabled: false } })).status(),
      ).toBe(200);

      await test.step("Hand off: the new owner is told, the previous owner isn't", async () => {
        const res = await owner.context.request.post(`/api/v1/weddings/${w}/transfer-ownership`, { data: { collaboratorId } });
        expect(res.status()).toBe(200);
        const notices = await handedOff(heir.context.request);
        expect(notices).toHaveLength(1);
        expect(notices[0].message).toContain(weddingName);
        expect(notices[0].message).toContain("you're now its owner");
        expect(await handedOff(owner.context.request)).toHaveLength(0);
      });

      await test.step("Each person's own email switch went with them", async () => {
        expect(await mine(heir.context.request)).toBe(false);
        expect(await mine(owner.context.request)).toBe(true);
      });
    } finally {
      await owner.context.close();
      await heir.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.email-budgets-and-member-email-settings.emailed-invite-confirms-the-address",
    title: "accepting an invite that was emailed to the account's own address confirms that address",
    objective:
      "Confirms (TS-203) that an account that hasn't confirmed its email address can accept an invite whose email went out to that address -- the link only reached that inbox -- and that doing so confirms the address, so the invited teammate doesn't depend on a separate confirmation email.",
    expectedOutcome:
      "The invite returns 201 with emailed true and is recorded as emailed. The account starts unconfirmed; accepting returns 200 with emailConfirmed true; the account is then confirmed.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:authentication", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, browser, context }, testInfo) => {
    const invitee = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "invited", { confirmEmail: false });
    try {
      const sent = await context.request.post(`/api/v1/weddings/${managedWedding.id}/invites`, {
        data: { email: invitee.email, permissionLevel: "VIEW", role: "COLLABORATOR" },
      });
      expect(sent.status()).toBe(201);
      const body = (await sent.json()) as { invite: { id: string }; emailed: boolean };
      expect(body.emailed).toBe(true);
      expect(await inviteWasEmailed(body.invite.id)).toBe(true);
      // The test can't read the emailed link (only its hash is stored); this gives the same invite a
      // link it knows, as every invite test does.
      const token = await inviteToken(body.invite.id);

      expect(await testAccountEmailConfirmed(invitee.email)).toBe(false);
      const accept = await invitee.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
      expect(accept.status()).toBe(200);
      expect(((await accept.json()) as { emailConfirmed: boolean }).emailConfirmed).toBe(true);
      expect(await testAccountEmailConfirmed(invitee.email)).toBe(true);
    } finally {
      await invitee.context.close();
    }
  },
);
