/**
 * TS-217 / TS-218 / TS-220 (REQ-ACCESS-CONTROL, REQ-NON-FUNCTIONAL) — fixes from the eighth review:
 * - Raised from View to Edit with the Guests tab open, the notes and email boxes show the real note
 *   and address (they used to appear empty, and saving one replaced the real note).
 * - Lowered from Edit to View, private notes and emails leave the open Guests tab within seconds.
 * - A wedding handed to someone with the Collaborators tab open shows them the wedding note, and
 *   tabbing through the box doesn't delete it.
 * - "Back to dashboard" while a refused name ("J0hn") is being saved stays and shows why.
 * - Revoking an invite the person has just accepted says so (409), instead of looking revoked.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { patchWedding } from "../data/api.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { failRequests } from "../support/networkFaults.js";
import { inviteToken } from "../support/testDatabase.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";

// FR-1.6's five seconds, plus headroom for the 4s poll landing just after the change.
const WITHIN_SECONDS = { timeout: 15_000 };
const NOTE = "Severe nut allergy - EpiPen";

defineQualityTest(
  {
    id: "cross-cutting.access-changes-and-leaving-keep-data-right.view-to-edit-shows-the-real-note",
    title: "raised from View to Edit with the Guests tab open, the notes and email boxes show the real note and address, never empty boxes",
    objective:
      "Confirms (TS-217) that a View collaborator with the Guests tab open, raised to Edit by the owner, gets a notes box that holds the guest's real private note from the moment it appears and an email box with the real address -- before, both boxes appeared empty (the list loaded at View had no notes or emails), and leaving the notes box after typing replaced the real note.",
    expectedOutcome:
      "Before the change the row shows no notes box and no note. After 'Your access to this wedding was changed to Edit.' the notes box appears already holding the note, and the email box holds the address. The server still has the note.",
    requirementIds: ["REQ-ACCESS-CONTROL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@feature:guests", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const address = `pw-guest-ts217-${Date.now()}@example.invalid`;
    const guestId = (await weddingData.createGuest(w, { ...name, notes: NOTE, email: address })).id;
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
    try {
      const collaborator = await weddingData.addCollaborator(w, helper.email, "VIEW");
      const theirPage = await helper.context.newPage();
      const theirView = new WeddingDetailPage(theirPage);
      const theirGuests = new WeddingGuestsPage(theirPage);

      await test.step("At View, the Guests tab shows the guest without the note or address", async () => {
        await theirGuests.goto(w);
        await expect(theirView.yourAccessBadge()).toHaveText("Your access: View");
        await theirGuests.readOnlyGuestRow(fullName).expectVisible();
        await expect(theirGuests.textOnPage(NOTE)).toHaveCount(0);
        await expect(theirGuests.allNotesBoxes()).toHaveCount(0);
      });

      await test.step("Raised to Edit: the notes box appears already holding the real note", async () => {
        const res = await context.request.patch(`/api/v1/weddings/${w}/collaborators/${collaborator.id}`, {
          data: { permissionLevel: "EDIT" },
        });
        expect(res.status(), await res.text()).toBe(200);
        // The value the box has the first moment it is on the page -- never an empty box first.
        expect(await theirGuests.firstNotesBoxValueWhenItAppears(WITHIN_SECONDS.timeout)).toBe(NOTE);
        await expect(theirView.accessChangedNotice("Edit")).toBeVisible();
        const row = theirGuests.guestRow(fullName);
        expect(await row.notes()).toBe(NOTE);
        await expect(row.emailBox()).toHaveValue(address);
      });

      await test.step("The note on the server is untouched", async () => {
        const saved = (await weddingData.listGuests(w)).find((g) => g.id === guestId) as { notes?: string | null } | undefined;
        expect(saved?.notes).toBe(NOTE);
      });
    } finally {
      await helper.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.access-changes-and-leaving-keep-data-right.edit-to-view-hides-notes-and-emails",
    title: "lowered from Edit to View with the Guests tab open, private notes and email addresses leave the screen within seconds",
    objective:
      "Confirms (TS-217) that an Edit collaborator with the Guests tab open, lowered to View by the owner, stops seeing the guest's private note and email address within the refresh interval -- before, both stayed on every row until a reload, breaking the rule that View and Comment never see them.",
    expectedOutcome:
      "Before the change the row's notes box holds the note and the email box the address. After 'Your access to this wedding was changed to View.' neither box is on the page and neither the note nor the address appears anywhere on it.",
    requirementIds: ["REQ-ACCESS-CONTROL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@feature:guests", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const address = `pw-guest-ts217-${Date.now()}@example.invalid`;
    await weddingData.createGuest(w, { ...name, notes: NOTE, email: address });
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    try {
      const collaborator = await weddingData.addCollaborator(w, helper.email, "EDIT");
      const theirPage = await helper.context.newPage();
      const theirView = new WeddingDetailPage(theirPage);
      const theirGuests = new WeddingGuestsPage(theirPage);

      await test.step("At Edit, the row shows the note and the address", async () => {
        await theirGuests.goto(w);
        const row = theirGuests.guestRow(fullName);
        await row.expectVisible();
        expect(await row.notes()).toBe(NOTE);
        await expect(row.emailBox()).toHaveValue(address);
      });

      await test.step("Lowered to View: the note and the address leave the screen", async () => {
        const res = await context.request.patch(`/api/v1/weddings/${w}/collaborators/${collaborator.id}`, {
          data: { permissionLevel: "VIEW" },
        });
        expect(res.status(), await res.text()).toBe(200);
        await expect(theirView.accessChangedNotice("View")).toBeVisible(WITHIN_SECONDS);
        await expect(theirGuests.allNotesBoxes()).toHaveCount(0);
        await expect(theirGuests.allEmailBoxes()).toHaveCount(0);
        await expect(theirGuests.textOnPage(NOTE)).toHaveCount(0);
        await expect(theirGuests.textOnPage(address)).toHaveCount(0);
        await theirGuests.readOnlyGuestRow(fullName).expectVisible();
      });
    } finally {
      await helper.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.access-changes-and-leaving-keep-data-right.hand-off-keeps-the-wedding-note",
    title: "a wedding handed to someone with the Collaborators tab open shows them the wedding note, and tabbing through the box keeps it",
    objective:
      "Confirms (TS-218) that when the owner hands the wedding to an Edit collaborator who has the Collaborators tab open, the new owner's 'Wedding note' box fills with the owner-only note once their access changes, and that clicking into the box and tabbing away without typing sends no save and leaves the note in place -- before, the box stayed empty ('Nothing noted yet') and leaving it saved 'no note', deleting it.",
    expectedOutcome:
      "After 'Your access to this wedding was changed to Owner.' the note box reads the note. After clicking into it and pressing Tab, no settings save is sent, and the wedding still has the note.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const weddingNote = "Owner only: the ceremony moved to 3:00 PM";
    const newOwner = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "newowner");
    try {
      await weddingData.addCollaborator(w, newOwner.email, "EDIT");
      const set = await patchWedding(context.request, w, { data: { note: weddingNote } });
      expect(set.status(), await set.text()).toBe(200);
      const theirPage = await newOwner.context.newPage();
      const settings = new CollaboratorsTabPage(theirPage);
      await settings.goto(w);

      await test.step("The owner hands the wedding over", async () => {
        const collaborator = (await weddingData.listCollaborators(w)).find((c) => c.userEmail === newOwner.email)!;
        const res = await context.request.post(`/api/v1/weddings/${w}/transfer-ownership`, { data: { collaboratorId: collaborator.id } });
        expect(res.status(), await res.text()).toBe(200);
      });

      await test.step("The new owner's note box shows the note", async () => {
        await expect(new WeddingDetailPage(theirPage).accessChangedNotice("Owner")).toBeVisible(WITHIN_SECONDS);
        await expect(settings.weddingNoteInput()).toHaveValue(weddingNote);
      });

      await test.step("Clicking into the box and tabbing away saves nothing and keeps the note", async () => {
        const settingsSaves: string[] = [];
        theirPage.on("request", (r) => {
          if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`) settingsSaves.push(r.url());
        });
        await settings.weddingNoteInput().click();
        await settings.weddingNoteInput().press("Tab");
        await expect(settings.weddingNoteInput()).toHaveValue(weddingNote);
        // A save would go out the moment the box is left; the page's next access check (every 4
        // seconds) is sent after that, so once it has answered any save would have been seen.
        await theirPage.waitForResponse(
          (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`,
          WITHIN_SECONDS,
        );
        expect(settingsSaves).toHaveLength(0);
        const after = ((await (await newOwner.context.request.get(`/api/v1/weddings/${w}`)).json()) as {
          wedding: { note?: string | null };
        }).wedding;
        expect(after.note).toBe(weddingNote);
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

defineQualityTest(
  {
    id: "cross-cutting.access-changes-and-leaving-keep-data-right.back-to-dashboard-waits-for-the-save",
    title: "'Back to dashboard' while a refused name is being saved stays on the page and shows why",
    objective:
      "Confirms (TS-218) that clicking the page's own '← Back to dashboard' link while a guest's first-name box holds 'J0hn' -- which the server refuses with a 422 -- waits for that save like the browser's Back does (TS-206): the page stays, the row shows the refusal with 'J0hn' still in the box, and the unsaved-changes question is asked. Before, the link left at once and the typing and the reason were lost.",
    expectedOutcome:
      "After the click the address is still the wedding page, the question is showing, the row shows the refusal, the box still says 'J0hn', and the server still has the old first name.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const dashboard = new DashboardPage(page);
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    const guestId = (await weddingData.createGuest(w, name)).id;
    const refusal = "First name can only use letters, spaces, hyphens and apostrophes.";

    await test.step("Arrange: the wedding opened from the dashboard", async () => {
      await dashboard.goto();
      await dashboard.weddingLink(managedWedding.name).click();
      await page.waitForURL(new RegExp(`/weddings/${w}$`));
      await guests.guestRow(fullName).expectVisible();
    });

    await test.step("Typing 'J0hn' and clicking Back to dashboard stays, with the typing and the reason", async () => {
      const refuse = await failRequests(page, new RegExp(`/api/v1/weddings/[^/]+/guests/${guestId}$`), "PATCH", {
        status: 422,
        error: refusal,
      });
      const row = guests.guestRow(fullName);
      await row.typeFirstNameWithoutLeaving("J0hn");
      await wedding.backToDashboardLink().click();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/weddings/${w}$`));
      await expect(row.locator().getByText(refusal)).toBeVisible();
      await expect(row.firstNameBox()).toHaveValue("J0hn");
      expect(refuse.hits).toBe(1);
      expect((await weddingData.listGuests(w)).find((g) => g.id === guestId)?.firstName).toBe(name.firstName);
      await wedding.stayOnTab();
      await refuse.clear();
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.access-changes-and-leaving-keep-data-right.revoke-after-accept-says-so",
    title: "revoking an invite the person has just accepted says they accepted it, and shows them under the people with access",
    objective:
      "Confirms (TS-220) that when the owner presses Revoke on an invite that the invitee accepted a moment earlier (the owner's list still shows it as pending), the page says they accepted it and to remove them from Collaborators if needed, and the collaborators list is loaded again so they show there -- before, the server's 404 counted as 'already revoked', the row disappeared and the owner believed access was blocked while the person had it.",
    expectedOutcome:
      "The revoke answers 409 and the page shows 'They accepted this invite a moment ago'. The invitee's row is listed under the people with access, and they still have access to the wedding.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const invitee = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "invitee");
    try {
      const created = await weddingData.createInvite(w, invitee.email, "VIEW");
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const inviteId = created.body.invite!.id;
      const collaboratorsTab = new CollaboratorsTabPage(page);
      await collaboratorsTab.goto(w);
      await expect(collaboratorsTab.pendingInvite(invitee.email)).toBeVisible();

      await test.step("The invitee accepts while the owner's list still shows the invite", async () => {
        const token = await inviteToken(inviteId);
        const accept = await invitee.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
        expect(accept.status(), await accept.text()).toBe(200);
      });

      await test.step("Revoke says they accepted, and they show under the people with access", async () => {
        const answered = page.waitForResponse(
          (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/v1/weddings/${w}/invites/${inviteId}`,
        );
        await collaboratorsTab.revokeInvite(invitee.email);
        expect((await answered).status()).toBe(409);
        await expect(collaboratorsTab.revokeError()).toContainText("They accepted this invite a moment ago");
        await expect(collaboratorsTab.person(invitee.email)).toBeVisible();
        const read = await invitee.context.request.get(`/api/v1/weddings/${w}`);
        expect(read.status()).toBe(200);
      });
    } finally {
      await invitee.context.close();
    }
  },
);
