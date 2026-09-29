/**
 * TS-112 (REQ-GUEST-LIST-MANAGEMENT, REQ-ACCOUNT-WEDDING-MANAGEMENT) — follow-ups from TS-96's
 * first-run review:
 *
 * - creating a wedding from the dashboard now opens it (with its Getting started steps) instead of
 *   leaving the planner to find it in the list;
 * - the add-guest form shows only the two required fields up front; the other eight optional ones
 *   sit behind "More details" and still save exactly as before once opened.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";

interface GuestRow {
  id: string;
  lastName: string;
  partyName: string | null;
  email: string | null;
  tier: string;
  rsvpStatus: string;
}

defineQualityTest(
  {
    id: "guest-list.a-name-is-all-it-takes-to-add-a-guest-or-a-wedding.opens-new-wedding-and-collapsed-optional-fields",
    title: "creating a wedding opens it, and a guest can be added with just a name while every optional field stays one click away and saves as before",
    objective:
      "Confirms creating a wedding on the dashboard lands on that wedding's page with its Getting started steps; that the add-guest form hides its optional fields until 'More details' is opened; that a name-only guest gets the usual defaults; and that optional fields entered after opening 'More details' are saved.",
    expectedOutcome:
      "After 'Add wedding' the browser is on /weddings/:id showing the new wedding and Getting started. The party field is hidden until 'More details' is clicked. A name-only guest saves with tier OTHER and RSVP PENDING; a guest added with a household and email after opening 'More details' saves both.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ account, weddingData, weddingGuestsPage, context, page }, testInfo) => {
    void account;
    const detailPage = new WeddingDetailPage(page);
    const name = uniqueTitle(testInfo.workerIndex, "First Run Wedding");
    let weddingId = "";

    await test.step("Act + Assert: creating a wedding opens it, Getting started and all", async () => {
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      await dashboard.createWeddingAndLandOnIt(name);
      weddingId = new URL(page.url()).pathname.split("/").pop()!;
      weddingData.trackWedding(weddingId);
      await expect(detailPage.heading()).toHaveText(name);
      await expect(detailPage.gettingStarted()).toBeVisible();
    });

    const guests = async () => ((await (await context.request.get(`/api/v1/weddings/${weddingId}/guests`)).json()) as { guests: GuestRow[] }).guests;

    await test.step("Act + Assert: optional fields are hidden, and a name alone adds a guest with the usual defaults", async () => {
      await expect(weddingGuestsPage.optionalFieldsVisible()).toHaveCount(0);
      const plain = uniquePersonName(testInfo.workerIndex);
      await weddingGuestsPage.addGuest(plain);
      await weddingGuestsPage.guestRow(`${plain.firstName} ${plain.lastName}`).expectVisible();
      const saved = (await guests()).find((g) => g.lastName === plain.lastName)!;
      expect({ tier: saved.tier, rsvp: saved.rsvpStatus, party: saved.partyName }).toEqual({ tier: "OTHER", rsvp: "PENDING", party: null });
    });

    await test.step("Act + Assert: after 'More details', optional fields show and save", async () => {
      const detailed = uniquePersonName(testInfo.workerIndex);
      await weddingGuestsPage.addGuest({ ...detailed, partyName: "The Example Household", email: "guest@example.invalid" });
      await expect(weddingGuestsPage.optionalFieldsVisible()).toBeVisible();
      await weddingGuestsPage.guestRow(`${detailed.firstName} ${detailed.lastName}`).expectVisible();
      const saved = (await guests()).find((g) => g.lastName === detailed.lastName)!;
      expect({ party: saved.partyName, email: saved.email }).toEqual({ party: "The Example Household", email: "guest@example.invalid" });
    });
  },
);
