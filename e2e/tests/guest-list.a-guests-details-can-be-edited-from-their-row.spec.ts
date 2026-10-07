/**
 * TS-202 (REQ-GUEST-LIST-MANAGEMENT) — a guest's party size, tier, household, age category and
 * "needs an accessible table" could only be set on the Add guest form. A guest added as a party of
 * one could never RSVP for two, and a mistyped tier could only be fixed by re-importing or deleting
 * the guest. Each row now has "Edit details" (Owner/Edit only), saved with the guest's revision.
 * Also: a party of one keeps no plus-ones, and a Day-of walk-in can be a party bigger than one.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { safariTabSkipsButtons } from "../support/tabOrder.js";

interface GuestState {
  headcount: number;
  tier: string;
  partyName: string | null;
  ageCategory: string;
  requiresAccessibleTable: boolean;
  plusOneNames: string | null;
  revision: number;
}

defineQualityTest(
  {
    id: "guest-list.a-guests-details-can-be-edited-from-their-row.edit-each-field-and-reload",
    title: "a planner can change a guest's party size, tier, household, age and accessible need from their row, and the changes stick after a reload",
    objective:
      "Confirms that 'Edit details' opens the five fields in the guest's row with the saved values, that Tab moves through them in reading order, that Cancel puts the saved values back and returns focus to the Edit details button, that an open form with a change counts as unsaved (leaving the tab asks first), that Save sends every changed field and focus returns to the button, that the changes are still there after a reload, and that lowering the party size to 1 clears the guest's plus-ones (and the row stops showing them).",
    expectedOutcome:
      "After Save and a reload the API has headcount 1, tier FAMILY, household 'The Lee House', age CHILD, requiresAccessibleTable true and plusOneNames null; the form shows the same values when opened again; the row no longer reads 'with Sam Lee'. Cancel left the API unchanged.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const guest = await weddingData.createGuest(w, { ...name, headcount: 2, plusOneNames: "Sam Lee" });
    const saved = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${guest.id}`)).json()) as { guest: GuestState }).guest;

    await weddingGuestsPage.goto(w);
    await weddingGuestsPage.openGuestsTab();
    const row = weddingGuestsPage.guestRow(fullName);
    await row.expectVisible();
    await expect(row.summaryLine()).toContainText("with Sam Lee");

    await test.step("Edit details shows the saved values, Tab goes left to right then down, and Cancel puts them back", async () => {
      await row.openDetails();
      await expect(row.detailsField("partyName")).toBeFocused();
      await expect(row.detailsField("headcount")).toHaveValue("2");
      await expect(row.detailsField("tier")).toHaveValue("OTHER");
      await expect(row.detailsField("ageCategory")).toHaveValue("ADULT");
      await expect(row.detailsField("accessible")).not.toBeChecked();
      // Safari on macOS doesn't Tab to checkboxes by default (see safariTabSkipsButtons).
      const tabStops = safariTabSkipsButtons(testInfo.project.name)
        ? (["headcount", "tier", "ageCategory"] as const)
        : (["headcount", "tier", "ageCategory", "accessible"] as const);
      for (const next of tabStops) {
        await page.keyboard.press("Tab");
        await expect(row.detailsField(next)).toBeFocused();
      }
      await row.fillDetails({ headcount: "5", tier: "VIP" });
      await row.cancelDetails();
      await expect(row.detailsForm()).toHaveCount(0);
      await expect(row.editDetailsButton()).toBeFocused();
      const after = await saved();
      expect(after.headcount).toBe(2);
      expect(after.tier).toBe("OTHER");
      // Opened again, the form shows the saved values, not what was typed before Cancel.
      await row.openDetails();
      await expect(row.detailsField("headcount")).toHaveValue("2");
      await row.cancelDetails();
    });

    await test.step("While the form is open with a change, leaving the tab asks first", async () => {
      const wedding = new WeddingDetailPage(page);
      await row.openDetails();
      await row.fillDetails({ headcount: "4" });
      await wedding.clickTab("Tables");
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
      await expect(row.detailsField("headcount")).toHaveValue("4");
      // Cancelled, nothing is unsaved any more: the tab switches straight away.
      await row.cancelDetails();
      await wedding.clickTab("Tables");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await weddingGuestsPage.openGuestsTab();
      await row.expectVisible();
    });

    await test.step("Save sends every changed field; the party of one loses its plus-ones", async () => {
      await row.openDetails();
      await row.fillDetails({
        partyName: "The Lee House",
        headcount: "1",
        tier: "FAMILY",
        ageCategory: "CHILD",
        requiresAccessibleTable: true,
      });
      expect(await row.saveDetails()).toBe(200);
      await expect(row.detailsForm()).toHaveCount(0);
      await expect(row.editDetailsButton()).toBeFocused();
      const after = await saved();
      expect(after).toMatchObject({
        headcount: 1,
        tier: "FAMILY",
        partyName: "The Lee House",
        ageCategory: "CHILD",
        requiresAccessibleTable: true,
        plusOneNames: null,
      });
    });

    await test.step("After a reload the row and the form show the new details", async () => {
      await page.reload();
      await weddingGuestsPage.openGuestsTab();
      await row.expectVisible();
      await expect(row.summaryLine()).toContainText("The Lee House");
      await expect(row.summaryLine()).toContainText("Family");
      await expect(row.summaryLine()).not.toContainText("Sam Lee");
      await row.openDetails();
      await expect(row.detailsField("partyName")).toHaveValue("The Lee House");
      await expect(row.detailsField("headcount")).toHaveValue("1");
      await expect(row.detailsField("tier")).toHaveValue("FAMILY");
      await expect(row.detailsField("ageCategory")).toHaveValue("CHILD");
      await expect(row.detailsField("accessible")).toBeChecked();
      // Typing limits: the household box stops at its limit, the party size takes digits only.
      await expect(row.detailsField("partyName")).toHaveAttribute("maxlength", "200");
      await row.cancelDetails();
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.a-guests-details-can-be-edited-from-their-row.bigger-party-can-rsvp",
    title: "after the planner raises a guest's party size, the guest can RSVP for the bigger party and the RSVP page says how many the invitation is for",
    objective:
      "Confirms that a guest added as a party of one, whose party size the planner raises to 3 from the guest's row, sees 'Your invitation is for up to 3 people.' on their RSVP page and can answer for 3.",
    expectedOutcome:
      "Before the change the RSVP page says 'Your invitation is for up to 1 person.'. After the planner saves 3, the page says 'up to 3 people', the guest submits 3, and the API has headcount 3 and rsvpStatus CONFIRMED.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const guest = await weddingData.createGuest(w, name);
    const linkRes = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
    expect(linkRes.ok()).toBe(true);
    const token = ((await linkRes.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;

    const guestContext = await browser.newContext();
    try {
      const rsvp = new GuestRsvpPage(await guestContext.newPage());

      await test.step("A party of one is told so on the RSVP page", async () => {
        await rsvp.goto(token);
        await rsvp.choose("CONFIRMED");
        await expect(rsvp.pageText("Your invitation is for up to 1 person.")).toBeVisible();
      });

      await test.step("The planner raises the party size to 3 from the guest's row", async () => {
        await weddingGuestsPage.goto(w);
        await weddingGuestsPage.openGuestsTab();
        const row = weddingGuestsPage.guestRow(fullName);
        await row.openDetails();
        await row.fillDetails({ headcount: "3" });
        expect(await row.saveDetails()).toBe(200);
      });

      await test.step("The guest can now answer for 3", async () => {
        await rsvp.goto(token);
        await rsvp.choose("CONFIRMED");
        await expect(rsvp.pageText("Your invitation is for up to 3 people.")).toBeVisible();
        await rsvp.fillPartySize(3);
        await rsvp.fillPlusOneNames("Sam Lee, Jo Lee");
        await rsvp.submitAsShown();
        await expect(rsvp.successBanner()).toBeVisible();
        const after = ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${guest.id}`)).json()) as {
          guest: GuestState & { rsvpStatus: string };
        }).guest;
        expect(after.headcount).toBe(3);
        expect(after.rsvpStatus).toBe("CONFIRMED");
        expect(after.plusOneNames).toBe("Sam Lee, Jo Lee");
      });
    } finally {
      await guestContext.close();
    }
  },
);

defineQualityTest(
  {
    id: "guest-list.a-guests-details-can-be-edited-from-their-row.refusals-keep-what-was-typed",
    title: "a refused or stale details save shows the reason in the guest's row and keeps what the planner typed",
    objective:
      "Confirms that raising the party size of a guest on a full Restricted table's required-guest list is refused with the reason shown in the form and the typed values kept, that marking them as needing an accessible table while that table isn't accessible is refused the same way, and that a save based on a guest someone else changed meanwhile (409) says so, shows the latest in the row, keeps the typed values, and saves on the next try.",
    expectedOutcome:
      "Each refusal shows its message inside the details form with the typed party size or checkbox still there, and the API is unchanged. After the other change, Save shows 'changed since you loaded it', the form still reads 'The Lee House' and its untouched tier now reads VIP (the other change); saving again stores 'The Lee House' together with tier VIP.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@feature:tables", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, context }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const guest = await weddingData.createGuest(w, name);
    const table = await weddingData.createTable(w, { label: "Head Table", capacity: 2, isRestricted: true });
    await weddingData.setRequiredGuests(w, table.id, [guest.id]);
    const saved = async () =>
      ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${guest.id}`)).json()) as { guest: GuestState }).guest;

    await weddingGuestsPage.goto(w);
    await weddingGuestsPage.openGuestsTab();
    const row = weddingGuestsPage.guestRow(fullName);
    await row.expectVisible();

    await test.step("A bigger party than the Restricted table's list allows is refused, and the typed values stay", async () => {
      await row.openDetails();
      await row.fillDetails({ headcount: "3", partyName: "The Lee House" });
      expect(await row.saveDetails()).toBe(422);
      await expect(row.detailsError()).toContainText("required-guest list");
      await expect(row.detailsField("headcount")).toHaveValue("3");
      await expect(row.detailsField("partyName")).toHaveValue("The Lee House");
      const after = await saved();
      expect(after.headcount).toBe(1);
      expect(after.partyName).toBeNull();
    });

    await test.step("Needing an accessible table while required at one that isn't accessible is refused the same way", async () => {
      await row.fillDetails({ headcount: "1", requiresAccessibleTable: true });
      expect(await row.saveDetails()).toBe(422);
      await expect(row.detailsError()).toContainText("isn't marked Accessible");
      await expect(row.detailsField("accessible")).toBeChecked();
      expect((await saved()).requiresAccessibleTable).toBe(false);
    });

    await test.step("A save over someone else's change says so, keeps the typed values, and saves on the next try", async () => {
      await row.fillDetails({ requiresAccessibleTable: false });
      // Someone else changes the guest meanwhile.
      const before = await saved();
      const other = await context.request.patch(`/api/v1/weddings/${w}/guests/${guest.id}`, {
        data: { tier: "VIP", expectedRevision: before.revision },
      });
      expect(other.ok()).toBe(true);
      expect(await row.saveDetails()).toBe(409);
      await expect(row.detailsError()).toContainText("changed since you loaded it");
      await expect(row.detailsField("partyName")).toHaveValue("The Lee House");
      await expect(row.summaryLine()).toContainText("VIP");
      // A field the planner didn't touch follows the other change, so saving again doesn't undo it.
      await expect(row.detailsField("tier")).toHaveValue("VIP");
      expect(await row.saveDetails()).toBe(200);
      const after = await saved();
      expect(after.partyName).toBe("The Lee House");
      expect(after.tier).toBe("VIP");
    });
  },
);

defineQualityTest(
  {
    id: "guest-list.a-guests-details-can-be-edited-from-their-row.view-user-has-no-edit-control",
    title: "a View collaborator doesn't get the Edit details control on a guest's row",
    objective:
      "Confirms the 'Edit details' button is shown to the owner but not to a View collaborator, who still sees the guest's details as read-only text.",
    expectedOutcome:
      "The owner's row has one 'Edit details for <name>' button; the View collaborator's row has none and no details form, and shows the household as text.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, browser }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    await weddingData.createGuest(w, { ...name, partyName: "The Lee House" });

    await weddingGuestsPage.goto(w);
    await weddingGuestsPage.openGuestsTab();
    await expect(weddingGuestsPage.guestRow(fullName).editDetailsButton()).toHaveCount(1);

    const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
    try {
      await weddingData.addCollaborator(w, viewer.email, "VIEW");
      const viewerTab = new WeddingGuestsPage(await viewer.context.newPage());
      await viewerTab.goto(w);
      await viewerTab.openGuestsTab();
      const row = viewerTab.readOnlyGuestRow(fullName);
      await expect(row.locator()).toContainText("The Lee House");
      await expect(row.editDetailsButton()).toHaveCount(0);
      await expect(row.detailsForm()).toHaveCount(0);
    } finally {
      await viewer.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "guest-list.a-guests-details-can-be-edited-from-their-row.walk-in-party-size",
    title: "a Day-of walk-in can be added as a party bigger than one",
    objective:
      "Confirms the Day-of 'Add a walk-in' form has a party size box that starts at 1 and that a walk-in added with 3 is saved as a party of 3.",
    expectedOutcome: "The party size box reads 1 before anything is typed; the walk-in added with 3 has headcount 3 in the API.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.createTable(w, { label: "Table One", capacity: 8 });
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.generatePlanVersion(w);
    const walkIn = uniquePersonName(testInfo.workerIndex);

    const dayOf = new DayOfTabPage(page);
    await dayOf.goto(w);
    await expect(dayOf.walkInPartySizeInput()).toHaveValue("1");
    await dayOf.addWalkIn(walkIn.firstName, walkIn.lastName, undefined, 3);

    await expect
      .poll(async () => {
        const res = await context.request.get(`/api/v1/weddings/${w}/guests`);
        const { guests } = (await res.json()) as { guests: (GuestState & { firstName: string; lastName: string })[] };
        return guests.find((g) => g.firstName === walkIn.firstName && g.lastName === walkIn.lastName)?.headcount;
      })
      .toBe(3);
    await expect(dayOf.walkInPartySizeInput()).toHaveValue("1");
  },
);
