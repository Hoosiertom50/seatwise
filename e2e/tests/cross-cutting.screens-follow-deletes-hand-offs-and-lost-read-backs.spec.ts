/**
 * TS-206 / TS-207 / TS-208 / TS-209 / TS-214 (REQ-NON-FUNCTIONAL) — screens keep up with changes
 * made elsewhere after the seventh review's combined fixes.
 * - A guest deleted elsewhere while their name is being edited: the row goes, with a message, and
 *   nothing is left "unsaved" -- so the 4-second guest refresh keeps running.
 * - A Day-of message about a guest who has since been deleted goes away with them.
 * - A wedding handed to someone with its settings open shows them the latest settings, so their
 *   first save doesn't put an older venue back.
 * - A guest or table edit that saved but couldn't be read back doesn't make the next edit fail as
 *   "changed since you loaded it".
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { beforeRequests, dropReadBack } from "../support/networkFaults.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";

const GUEST_PATCH = /\/api\/v1\/weddings\/[^/]+\/guests\/[^/]+$/;

defineQualityTest(
  {
    id: "cross-cutting.screens-follow-deletes-hand-offs-and-lost-read-backs.guest-deleted-while-editing",
    title: "a guest deleted elsewhere while their name is edited leaves the list, with a message, and the list keeps refreshing",
    objective:
      "Confirms (TS-209) that when a guest is deleted by someone else just before an edit to their first name is saved, the Guests tab removes the row and says so instead of keeping the typed name as 'not saved yet' for good, and that the page's 4-second guest refresh (which waits while anything is unsaved) keeps working -- a guest added elsewhere afterwards shows up.",
    expectedOutcome:
      "The save answers 404. 'That guest was removed (maybe by someone else) — the list has been updated.' is shown, the row is gone and no 'Not saved yet' note is left. A guest then added through the API appears in the list within the refresh interval.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const guest = await weddingData.createGuest(w, name);
    await weddingGuestsPage.goto(w);
    await weddingGuestsPage.openGuestsTab();
    const row = weddingGuestsPage.guestRow(`${name.firstName} ${name.lastName}`);
    await expect(row.locator()).toHaveCount(1);

    await test.step("Someone else deletes the guest just as the new first name is saved", async () => {
      await beforeRequests(page, GUEST_PATCH, "PATCH", () => weddingData.deleteGuest(w, guest.id));
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === "PATCH" && GUEST_PATCH.test(new URL(r.url()).pathname)),
        row.editFirstName(`${name.firstName}a`),
      ]);
      expect(res.status()).toBe(404);
    });

    await test.step("The row goes, with a message, and nothing is left unsaved", async () => {
      await expect(weddingGuestsPage.message("That guest was removed (maybe by someone else) — the list has been updated.")).toBeVisible();
      await expect(row.locator()).toHaveCount(0);
      await expect(weddingGuestsPage.guestRow(`${name.firstName}a ${name.lastName}`).locator()).toHaveCount(0);
      await expect(row.notSavedYetNote()).toHaveCount(0);
    });

    await test.step("The list keeps refreshing: a guest added elsewhere shows up", async () => {
      const other = uniquePersonName(testInfo.workerIndex);
      await weddingData.createGuest(w, other);
      await expect(weddingGuestsPage.guestRow(`${other.firstName} ${other.lastName}`).locator()).toHaveCount(1, { timeout: 15_000 });
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-follow-deletes-hand-offs-and-lost-read-backs.day-of-message-goes-with-a-deleted-guest",
    title: "a Day-of message about a guest deleted elsewhere goes away with them",
    objective:
      "Confirms (TS-208) that when 'Mark not attending' is pressed for a guest someone else has just deleted, the refusal shown for that guest goes away once the list catches up and the guest is gone -- it used to stay at the top of the tab for good.",
    expectedOutcome:
      "The attendance request answers 404. Within the refresh interval the guest's row is gone and the refusal's text is no longer on the page.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const fullName = `${name.firstName} ${name.lastName}`;
    const guest = await weddingData.createGuest(w, name);
    const dayOf = new DayOfTabPage(page);
    await dayOf.goto(w);
    await expect(dayOf.attendanceButtonLocator(fullName)).toBeVisible();

    const refusal = await test.step("The guest is deleted elsewhere just as they're marked not attending", async () => {
      await beforeRequests(page, /\/guests\/[^/]+\/attendance$/, "POST", () => weddingData.deleteGuest(w, guest.id));
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === "POST" && /\/attendance$/.test(new URL(r.url()).pathname)),
        dayOf.attendanceButtonLocator(fullName).click(),
      ]);
      expect(res.status()).toBe(404);
      return ((await res.json()) as { error: string }).error;
    });

    await test.step("Once the list catches up, the guest and the message about them are gone", async () => {
      await expect(dayOf.guestRowLocator(fullName)).toHaveCount(0, { timeout: 15_000 });
      await expect(dayOf.errorText().filter({ hasText: refusal })).toHaveCount(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-follow-deletes-hand-offs-and-lost-read-backs.hand-off-shows-the-latest-settings",
    title: "a wedding handed to someone with its settings open shows them the latest venue, and their first save keeps it",
    objective:
      "Confirms (TS-214) that when the owner changes the venue and then hands the wedding to an Edit collaborator who has the Collaborators tab open, the new owner's venue box shows the new venue once their access changes, and saving a date from there keeps that venue -- before, the box kept the old (empty) venue under the newer settings revision, so the save quietly cleared it.",
    expectedOutcome:
      "After 'Your access to this wedding was changed to Owner.' the venue box reads 'The Old Barn'. Saving date 2027-06-12 answers 200, and the wedding then has that date and still 'The Old Barn'.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:account", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const newOwner = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "newowner");
    try {
      await weddingData.addCollaborator(w, newOwner.email, "EDIT");
      const theirPage = await newOwner.context.newPage();
      const settings = new CollaboratorsTabPage(theirPage);
      await settings.goto(w);
      await expect(settings.peopleHeading()).toBeVisible();

      await test.step("The owner sets the venue, then hands the wedding over", async () => {
        const venue = await context.request.patch(`/api/v1/weddings/${w}`, { data: { venueName: "The Old Barn" } });
        expect(venue.status(), await venue.text()).toBe(200);
        const collaborator = (await weddingData.listCollaborators(w)).find((c) => c.userEmail === newOwner.email)!;
        const res = await context.request.post(`/api/v1/weddings/${w}/transfer-ownership`, { data: { collaboratorId: collaborator.id } });
        expect(res.status(), await res.text()).toBe(200);
      });

      await test.step("The new owner's settings show the latest venue", async () => {
        await expect(new WeddingDetailPage(theirPage).accessChangedNotice("Owner")).toBeVisible({ timeout: 15_000 });
        await expect(settings.venueInput()).toHaveValue("The Old Barn");
      });

      await test.step("Saving a date from there keeps the venue", async () => {
        expect(await settings.submitDateAndVenue("2027-06-12")).toBe(200);
        const after = ((await (await newOwner.context.request.get(`/api/v1/weddings/${w}`)).json()) as {
          wedding: { eventDate: string | null; venueName: string | null };
        }).wedding;
        expect(after.eventDate).toBe("2027-06-12");
        expect(after.venueName).toBe("The Old Barn");
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
    id: "cross-cutting.screens-follow-deletes-hand-offs-and-lost-read-backs.next-edit-after-a-lost-read-back",
    title: "after a guest or table edit saved but couldn't be read back, the next edit still saves",
    objective:
      "Confirms (TS-209) that when a guest's name change, or a table's Accessible box, is saved but the answer comes without the record (the server couldn't read it back), the next edit to the same guest or table is sent with the record's new revision and saves -- it used to be refused as 'changed since you loaded it'.",
    expectedOutcome:
      "The guest's second name change answers 200 and the API has the second name. The table's Single-side change answers 200 and the API has the table both Accessible and Single-side.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-GUEST-LIST-MANAGEMENT", "REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:guests", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, page }, testInfo) => {
    const w = managedWedding.id;
    const name = uniquePersonName(testInfo.workerIndex);
    const guest = await weddingData.createGuest(w, name);
    const savedPatch = (path: RegExp) =>
      page.waitForResponse((r) => r.request().method() === "PATCH" && path.test(new URL(r.url()).pathname));

    await test.step("Guest: the first name change comes back without the guest; the next one still saves", async () => {
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      await dropReadBack(page, GUEST_PATCH, "PATCH", "guest");
      const first = `${name.firstName}a`;
      const [one] = await Promise.all([
        savedPatch(GUEST_PATCH),
        weddingGuestsPage.guestRow(`${name.firstName} ${name.lastName}`).editFirstName(first),
      ]);
      expect(one.status()).toBe(200);
      await expect(weddingGuestsPage.guestRow(`${first} ${name.lastName}`).locator()).toHaveCount(1);
      const second = `${name.firstName}b`;
      const [two] = await Promise.all([
        savedPatch(GUEST_PATCH),
        weddingGuestsPage.guestRow(`${first} ${name.lastName}`).editFirstName(second),
      ]);
      expect(two.status()).toBe(200);
      const listed = (await weddingData.listGuests(w)).find((g) => g.id === guest.id);
      expect(listed?.firstName).toBe(second);
    });

    await test.step("Table: Accessible comes back without the table; Single-side still saves", async () => {
      const table = await weddingData.createTable(w, { label: "Garden", capacity: 8 });
      const tablePatch = /\/api\/v1\/weddings\/[^/]+\/tables\/[^/]+$/;
      const tables = new TablesTabPage(page);
      await tables.goto(w);
      await tables.openTablesTab();
      await dropReadBack(page, tablePatch, "PATCH", "table");
      const [one] = await Promise.all([savedPatch(tablePatch), tables.accessibleCheckbox("Garden").check()]);
      expect(one.status()).toBe(200);
      const [two] = await Promise.all([savedPatch(tablePatch), tables.singleSideCheckbox("Garden").check()]);
      expect(two.status()).toBe(200);
      const after = (await weddingData.listTables(w)).find((t) => t.id === table.id);
      expect(after?.isAccessible).toBe(true);
      expect(after?.singleSideOnly).toBe(true);
    });
  },
);
