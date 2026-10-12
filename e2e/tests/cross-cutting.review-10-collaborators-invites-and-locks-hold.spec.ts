/**
 * TS-242 / TS-237 / TS-246 (REQ-COLLABORATION-NOTIFICATIONS, REQ-ACCOUNT-WEDDING-MANAGEMENT,
 * REQ-DAY-OF-TIMELINE) — review 10's screen fixes for collaborators, invites and the timeline.
 * - After a hand-off, the new owner's open Collaborators tab lists the old owner, with their email
 *   and a Remove button (the list is loaded again when ownership changes).
 * - An accepted invite opened while signed in offers "Open the wedding" (only for the person who
 *   accepted it) and every non-pending state offers "Go to your dashboard"; the page still shows
 *   nothing about the wedding.
 * - A timeline entry removed while a reorder's reload is on its way doesn't come back.
 * - Two tabs: a settings box with typing in it whose setting was saved in the other tab is refused
 *   with "changed since you opened them" instead of overwriting it; the wedding-wide email switch
 *   follows across tabs and doesn't make the next save of either tab fail.
 * - The hand-off question says the private wedding note will be visible to the new owner.
 * The database-level fixes (invite re-send order, accept's 409, lock order, comment resolve) are
 * covered by apps/web/src/lib/review-10-collaborators-invites-and-locks.test.mts.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";
import { patchWedding } from "../data/api.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { InviteAcceptPage } from "../pages/InviteAcceptPage.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { signUpFreshAccountInNewContext, TEST_ACCOUNT_EMAIL_DOMAIN } from "../support/auth.js";
import { delayRequests, delayResponses } from "../support/networkFaults.js";
import { inviteToken } from "../support/testDatabase.js";

// Two of the page's 4-second checks, with headroom.
const WITHIN_SECONDS = { timeout: 10_000 };

const SETTINGS_CHANGED_ELSEWHERE =
  "This wedding's settings changed since you opened them (maybe in another tab) — showing the latest. Your change wasn't saved; make it again if it's still needed.";

defineQualityTest(
  {
    id: "cross-cutting.review-10-collaborators-invites-and-locks-hold.new-owner-sees-the-full-list",
    title: "after a hand-off, the new owner's open Collaborators tab lists the old owner with their email and a Remove button",
    objective:
      "Confirms (TS-242 item 1) that when the owner hands the wedding to an Edit collaborator who has the Collaborators tab open, the tab loads the list again once they become the owner: the old owner is listed (with their email, which only the owner sees) and can be removed -- before, the list stayed as a collaborator sees it until another tab was opened.",
    expectedOutcome:
      "After 'Your access to this wedding was changed to Owner.' the old owner's row shows their email and a Remove button, without a reload.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, account, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const newOwner = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "listowner");
    try {
      const collaborator = await weddingData.addCollaborator(w, newOwner.email, "EDIT");
      const theirPage = await newOwner.context.newPage();
      const theirTab = new CollaboratorsTabPage(theirPage);
      await theirTab.goto(w);
      await expect(theirTab.removeButtons()).toHaveCount(0);

      const res = await context.request.post(`/api/v1/weddings/${w}/transfer-ownership`, { data: { collaboratorId: collaborator.id } });
      expect(res.status(), await res.text()).toBe(200);

      await expect(new WeddingDetailPage(theirPage).accessChangedNotice("Owner")).toBeVisible(WITHIN_SECONDS);
      await expect(theirTab.person(account.email)).toBeVisible();
      await expect(theirTab.person(account.email).getByRole("button", { name: /^Remove / })).toBeVisible();

      await test.step("Clean up: the new owner deletes the wedding", async () => {
        const del = await newOwner.context.request.delete(`/api/v1/weddings/${w}`);
        expect([200, 404]).toContain(del.status());
      });
    } finally {
      await newOwner.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-10-collaborators-invites-and-locks-hold.invite-page-is-never-a-dead-end",
    title: "an accepted invite opens the wedding for the person who accepted it, and every non-pending invite offers the dashboard",
    objective:
      "Confirms (TS-242 item 2) that the invite page, opened after the invite was accepted, offers 'Open the wedding' to the signed-in person who accepted it (through the accept request, which answers with the wedding) and 'Go to your dashboard'; that someone else signed in gets the same buttons but 'Open the wedding' only says the invite is no longer valid; that a revoked link offers the dashboard; and that a signed-out visitor sees neither and nothing about the wedding.",
    expectedOutcome:
      "Invitee: 'already accepted', both buttons, and Open the wedding lands on /weddings/<id>. Someone else: the wedding's name is never shown and Open the wedding shows 'This invite is no longer valid.'. Revoked: the dashboard link. Signed out: no dashboard link.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    const w = managedWedding.id;
    const invitee = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "accepted");
    const someoneElse = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "otherone");
    const signedOut = await browser.newContext();
    try {
      const sent = await weddingData.createInvite(w, invitee.email, "EDIT");
      expect(sent.status).toBe(201);
      const token = await inviteToken(sent.body.invite!.id);
      const accepted = await invitee.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
      expect(accepted.status(), await accepted.text()).toBe(200);

      await test.step("The person who accepted it: Open the wedding takes them there", async () => {
        const theirPage = await invitee.context.newPage();
        const invitePage = new InviteAcceptPage(theirPage);
        await invitePage.goto(token);
        await expect(invitePage.stateMessage("ACCEPTED")).toBeVisible();
        await expect(invitePage.dashboardLink()).toBeVisible();
        await expect(invitePage.textLocator(managedWedding.name)).toHaveCount(0);
        await invitePage.openWeddingButton().click();
        await theirPage.waitForURL((url) => url.pathname === `/weddings/${w}`);
      });

      await test.step("Someone else: nothing about the wedding, and Open the wedding says it's no longer valid", async () => {
        const otherPage = await someoneElse.context.newPage();
        const invitePage = new InviteAcceptPage(otherPage);
        await invitePage.goto(token);
        await expect(invitePage.stateMessage("ACCEPTED")).toBeVisible();
        await expect(invitePage.dashboardLink()).toBeVisible();
        await invitePage.openWeddingButton().click();
        await expect(invitePage.openWeddingError()).toHaveText("This invite is no longer valid.");
        await expect(invitePage.textLocator(managedWedding.name)).toHaveCount(0);
        expect(new URL(otherPage.url()).pathname).toBe(`/invites/${token}`);
      });

      await test.step("A revoked link offers the dashboard; a signed-out visitor gets no dashboard link", async () => {
        const again = await weddingData.createInvite(w, `pw-revoked-${uniqueToken(testInfo.workerIndex)}${TEST_ACCOUNT_EMAIL_DOMAIN}`, "VIEW");
        expect(again.status).toBe(201);
        const revoked = await weddingData.revokeInvite(w, again.body.invite!.id);
        expect(revoked.status).toBe(200);
        const revokedToken = await inviteToken(again.body.invite!.id);
        const invitePage = new InviteAcceptPage(await someoneElse.context.newPage());
        await invitePage.goto(revokedToken);
        await expect(invitePage.stateMessage("REVOKED")).toBeVisible();
        await expect(invitePage.dashboardLink()).toBeVisible();
        await expect(invitePage.openWeddingButton()).toHaveCount(0);

        const visitor = new InviteAcceptPage(await signedOut.newPage());
        await visitor.goto(token);
        await expect(visitor.stateMessage("ACCEPTED")).toBeVisible();
        await expect(visitor.dashboardLink()).toHaveCount(0);
        await expect(visitor.openWeddingButton()).toHaveCount(0);
      });
    } finally {
      await invitee.context.close();
      await someoneElse.context.close();
      await signedOut.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-10-collaborators-invites-and-locks-hold.removed-timeline-entry-stays-gone",
    title: "a timeline entry removed while a reorder's reload is on its way doesn't come back on screen",
    objective:
      "Confirms (TS-242 item 6) that when an entry is removed while the list's reload after a reorder is still on its way (that reload was read before the delete), the entry stays off the screen when the reload lands and when the delete answers -- before, the list only counted the change once the DELETE answered, so the older reload put the entry back.",
    expectedOutcome:
      "The removed entry's row is gone at once, still gone after the held reload lands, still gone after the DELETE answers, and gone on the server.",
    requirementIds: ["REQ-DAY-OF-TIMELINE", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const tag = uniqueToken(testInfo.workerIndex);
    const first = `First dance ${tag}`;
    const second = `Cake cutting ${tag}`;
    const toast = `Toasts ${tag}`;
    expect((await weddingData.createTimelineEntry(w, { time: "16:00", description: first })).status).toBe(201);
    expect((await weddingData.createTimelineEntry(w, { time: "16:00", description: second })).status).toBe(201);
    expect((await weddingData.createTimelineEntry(w, { time: "18:00", description: toast })).status).toBe(201);

    const timeline = new TimelineTabPage(page);
    await timeline.goto(w);
    await expect(timeline.entryRowLocator(toast)).toHaveCount(1);

    // The reorder's reload is read at once but answered 3 seconds later; the DELETE reaches the
    // server only after 5 seconds -- so the reload still has the entry in it.
    const isList = (url: string) => /\/timeline-entries$/.test(new URL(url).pathname);
    const isDelete = (url: string) => /\/timeline-entries\/[^/]+$/.test(new URL(url).pathname);
    const slowReload = await delayResponses(page, /\/timeline-entries$/, "GET", 3_000);
    const slowDelete = await delayRequests(page, /\/timeline-entries\/[^/]+$/, "DELETE", 5_000);

    await timeline.startMoveUp(second);
    const reloadLands = page.waitForResponse((r) => r.request().method() === "GET" && isList(r.url()), WITHIN_SECONDS);
    const deleteLands = page.waitForResponse((r) => r.request().method() === "DELETE" && isDelete(r.url()), WITHIN_SECONDS);
    await timeline.startRemove(toast);
    await expect(timeline.entryRowLocator(toast)).toHaveCount(0);

    await test.step("The older reload lands: the entry stays gone", async () => {
      await reloadLands;
      await expect(timeline.entryRowLocator(toast)).toHaveCount(0);
    });
    await test.step("The DELETE answers: still gone, here and on the server", async () => {
      expect((await deleteLands).status()).toBe(200);
      await expect(timeline.entryRowLocator(toast)).toHaveCount(0);
      expect((await weddingData.getTimelineEntries(w)).some((e) => e.description === toast)).toBe(false);
    });
    await slowReload.clear();
    await slowDelete.clear();
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-10-collaborators-invites-and-locks-hold.two-tabs-same-setting-asks",
    title: "a wedding name typed in one tab isn't saved over a newer name saved in another tab -- it's refused with 'changed since you opened them'",
    objective:
      "Confirms (TS-246 item 1) that when the owner has the wedding name box typed in (not yet left) in one tab, and saves a different name from a second tab, leaving the box in the first tab -- after its 4-second check has brought in the newer settings -- doesn't overwrite the other tab's name: the save is refused with 'changed since you opened them', the box shows the newer name, and a fresh change afterwards saves normally. Before, the check moved the tab's settings version on, so the save quietly replaced the newer name.",
    expectedOutcome:
      "Tab 1 shows the 'changed since you opened them' message and the box reads tab 2's name; the server keeps tab 2's name; then a new name typed in tab 1 saves.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, page, context }, testInfo) => {
    const w = managedWedding.id;
    const tag = uniqueToken(testInfo.workerIndex);
    const tab1 = new CollaboratorsTabPage(page);
    const tab2 = new CollaboratorsTabPage(await context.newPage());
    await tab1.goto(w);
    await tab2.goto(w);
    const savedName = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: { name: string } }).wedding.name;

    await tab1.weddingNameInput().fill(`Tab one ${tag}`);
    await tab2.setAndLeave(tab2.weddingNameInput(), `Tab two ${tag}`);
    await expect.poll(savedName).toBe(`Tab two ${tag}`);

    await test.step("Tab 1's check brings in the newer settings, then leaving its box is refused", async () => {
      // A check sent after tab 2's save has answered carries the newer settings.
      await page.waitForResponse(
        (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`,
        WITHIN_SECONDS,
      );
      await page.waitForResponse(
        (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`,
        WITHIN_SECONDS,
      );
      await tab1.weddingNameInput().blur();
      await expect(tab1.message(SETTINGS_CHANGED_ELSEWHERE)).toBeVisible();
      await expect(tab1.weddingNameInput()).toHaveValue(`Tab two ${tag}`);
      expect(await savedName()).toBe(`Tab two ${tag}`);
    });

    await test.step("A fresh change from tab 1 then saves", async () => {
      await tab1.setAndLeave(tab1.weddingNameInput(), `Tab one again ${tag}`);
      await expect.poll(savedName).toBe(`Tab one again ${tag}`);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-10-collaborators-invites-and-locks-hold.email-switch-follows-across-tabs",
    title: "the wedding-wide email switch turned off in one tab shows off in the other, and both tabs' next settings saves still go through",
    objective:
      "Confirms (TS-237 item 4) that the 'Also send email notifications for this wedding' switch turned off in one tab shows as off in a second open tab within seconds (the switch now moves the settings version on, which the 4-second check follows), and that this doesn't make the next settings save of either tab fail as out of date.",
    expectedOutcome:
      "Tab 2's switch reads off within 10 seconds; a side-label change saved from tab 1 and a name change saved from tab 2 both save, with no 'changed since you opened them' message.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }, testInfo) => {
    const w = managedWedding.id;
    const tag = uniqueToken(testInfo.workerIndex);
    const tab1 = new CollaboratorsTabPage(page);
    const tab2 = new CollaboratorsTabPage(await context.newPage());
    await tab1.goto(w);
    await tab2.goto(w);
    await expect(tab1.emailNotificationsCheckbox()).toBeChecked();
    await expect(tab2.emailNotificationsCheckbox()).toBeChecked();

    await tab1.emailNotificationsCheckbox().uncheck();
    await expect(tab2.emailNotificationsCheckbox()).not.toBeChecked(WITHIN_SECONDS);

    const wedding = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: { name: string; sideLabel1: string; emailNotificationsEnabled: boolean } })
        .wedding;
    await tab1.setAndLeave(tab1.sideLabelInput(1), "Sam");
    await expect.poll(async () => (await wedding()).sideLabel1).toBe("Sam");
    await expect(tab1.message(SETTINGS_CHANGED_ELSEWHERE)).toHaveCount(0);

    // Tab 2 picks up tab 1's side label first (its untouched box refills), then saves a name.
    await expect(tab2.sideLabelInput(1)).toHaveValue("Sam", WITHIN_SECONDS);
    await tab2.setAndLeave(tab2.weddingNameInput(), `Switched ${tag}`);
    await expect.poll(async () => (await wedding()).name).toBe(`Switched ${tag}`);
    await expect(tab2.message(SETTINGS_CHANGED_ELSEWHERE)).toHaveCount(0);
    expect((await wedding()).emailNotificationsEnabled).toBe(false);
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-10-collaborators-invites-and-locks-hold.hand-off-question-mentions-the-note",
    title: "the hand-off question says the private wedding note will be visible to the new owner",
    objective:
      "Confirms (TS-246 item 2, Tom's decision) that when the wedding has a private note, the 'are you sure?' question for handing the wedding off says the note will be visible to the new owner, so the owner can clear it first; cancelling changes nothing.",
    expectedOutcome:
      "The hand-off question contains 'Your private wedding note will be visible to the new owner — clear it first if it's only for you.'; after Cancel the wedding still has its owner and note.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page, browser }, testInfo) => {
    const w = managedWedding.id;
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "notewarn");
    try {
      await weddingData.addCollaborator(w, helper.email, "EDIT");
      const set = await patchWedding(context.request, w, { data: { note: "Only for me: the budget is tight" } });
      expect(set.status(), await set.text()).toBe(200);

      const tab = new CollaboratorsTabPage(page);
      await tab.goto(w);
      await tab.openHandOffQuestion(helper.name);
      await expect(tab.handOffQuestion()).toContainText(
        "Your private wedding note will be visible to the new owner — clear it first if it's only for you.",
      );
      await tab.handOffQuestion().getByRole("button", { name: "Cancel", exact: true }).click();
      const after = ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: { ownerId: string; note?: string | null } })
        .wedding;
      expect(after.note).toBe("Only for me: the budget is tight");
    } finally {
      await helper.context.close();
    }
  },
);
