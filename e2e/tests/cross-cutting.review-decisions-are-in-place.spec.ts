/**
 * TS-154 (REQ-NON-FUNCTIONAL) — Tom's decisions from the 2026-10-02 review.
 * 1. Guests' private notes (the planner's and the guest's RSVP note) are seen only by the owner and
 *    Edit collaborators -- not by View or Comment collaborators, in the app or the CSV export.
 * 2. A guest can RSVP for at most the party size the planner set (and can change back up to it);
 *    the planner is notified when a guest responds.
 * 3. Correcting a guest's email to a different address makes a fresh RSVP link (the old one stops
 *    working) and emails it to the corrected address.
 * 5. The owner can set or change the wedding's date and venue after creating it.
 * (#4 and #6 shipped with TS-148 and TS-155.)
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { guestRsvpToken } from "../support/testDatabase.js";

test.use({ timezoneId: "America/Chicago", locale: "en-US" });

defineQualityTest(
  {
    id: "cross-cutting.review-decisions-are-in-place.notes-party-size-corrected-email-date-venue",
    title: "private notes are Edit-only, RSVPs are capped at the planner's party size and notify the planner, a corrected email gets a fresh link, and the date and venue can be edited",
    objective:
      "Confirms View and Comment collaborators get guests (and the CSV export) without private notes while Edit and the owner see them; that an RSVP above the planner's party size is refused with a clear message, one at or below it is accepted (including changing back up), and a planner raising the party size raises the limit; that each RSVP creates an 'RSVP' notification for the owner; that changing a guest's email to a different address replaces their RSVP link and emails it; and that the owner can set the date and venue from the Collaborators tab and see the date on the dashboard.",
    expectedOutcome:
      "View/Comment see notes and rsvpNotes as null and blank CSV note cells; Edit/owner see 'Nut allergy'. RSVP of 3 against a party of 2 gets 422 'up to 2 people'; 1 then 2 succeed; after the planner sets 4, 4 succeeds. The owner has RSVP_RECEIVED notifications. After the email change the old link reads NOT_FOUND, a new link works, and the response says it was emailed. The dashboard shows 9/18/2027 after saving the date.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:rsvp", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, page }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;

    await test.step("Private notes are only for the owner and Edit collaborators", async () => {
      const guest = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), notes: "Nut allergy" });
      const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
      const commenter = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "commenter");
      const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
      try {
        await weddingData.addCollaborator(w, viewer.email, "VIEW");
        await weddingData.addCollaborator(w, commenter.email, "COMMENT");
        await weddingData.addCollaborator(w, editor.email, "EDIT");
        const notesSeenBy = async (request: typeof context.request) => {
          const list = (await (await request.get(api("guests"))).json()) as { guests: { id: string; notes: string | null }[] };
          const one = (await (await request.get(api(`guests/${guest.id}`))).json()) as { guest: { notes: string | null } };
          const csv = await (await request.get(api("guests/export"))).text();
          return { list: list.guests.find((g) => g.id === guest.id)!.notes, one: one.guest.notes, inCsv: csv.includes("Nut allergy") };
        };
        expect(await notesSeenBy(viewer.context.request)).toEqual({ list: null, one: null, inCsv: false });
        expect(await notesSeenBy(commenter.context.request)).toEqual({ list: null, one: null, inCsv: false });
        expect(await notesSeenBy(editor.context.request)).toEqual({ list: "Nut allergy", one: "Nut allergy", inCsv: true });
        expect(await notesSeenBy(context.request)).toEqual({ list: "Nut allergy", one: "Nut allergy", inCsv: true });
      } finally {
        await viewer.context.close();
        await commenter.context.close();
        await editor.context.close();
      }
    });

    await test.step("RSVPs are capped at the planner's party size, and the planner is notified", async () => {
      const guest = await weddingData.createGuest(w, { ...uniquePersonName(testInfo.workerIndex), headcount: 2 });
      await context.request.post(api(`guests/${guest.id}/rsvp-link`), { data: {} });
      const token = (await guestRsvpToken(guest.id))!;
      const visitor = await browser.newContext();
      try {
        const rsvp = (headcount: number) =>
          visitor.request.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "CONFIRMED", headcount } });
        const over = await rsvp(3);
        expect(over.status()).toBe(422);
        expect(((await over.json()) as { error: string }).error).toContain("up to 2 people");
        expect((await rsvp(1)).status()).toBe(200);
        expect((await rsvp(2)).status()).toBe(200);
        const preview = (await (await visitor.request.get(`/api/v1/rsvp/${token}`)).json()) as { rsvp: { maxHeadcount: number } };
        expect(preview.rsvp.maxHeadcount).toBe(2);

        const current = ((await (await context.request.get(api(`guests/${guest.id}`))).json()) as { guest: { revision: number } }).guest;
        await context.request.patch(api(`guests/${guest.id}`), { data: { headcount: 4, expectedRevision: current.revision } });
        expect((await rsvp(4)).status()).toBe(200);
      } finally {
        await visitor.close();
      }
      const { notifications } = (await (await context.request.get("/api/v1/notifications")).json()) as {
        notifications: { type: string; message: string }[];
      };
      const rsvpNotes = notifications.filter((n) => n.type === "RSVP_RECEIVED");
      expect(rsvpNotes.length).toBeGreaterThanOrEqual(3);
      expect(rsvpNotes[0].message).toContain(guest.lastName);
    });

    await test.step("Correcting a guest's email makes a fresh link and emails it to the new address", async () => {
      const guest = await weddingData.createGuest(w, {
        ...uniquePersonName(testInfo.workerIndex),
        email: `pw-guest-typo-${Date.now()}@example.invalid`,
      });
      const oldToken = (await guestRsvpToken(guest.id))!;
      expect(oldToken).toBeTruthy();
      const current = ((await (await context.request.get(api(`guests/${guest.id}`))).json()) as { guest: { revision: number } }).guest;
      const res = await context.request.patch(api(`guests/${guest.id}`), {
        data: { email: `pw-guest-fixed-${Date.now()}@example.invalid`, expectedRevision: current.revision },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { rsvpEmail?: { emailed: boolean } };
      expect(body.rsvpEmail?.emailed).toBe(true);
      const newToken = (await guestRsvpToken(guest.id))!;
      expect(newToken).not.toBe(oldToken);
      const oldLink = (await (await context.request.get(`/api/v1/rsvp/${oldToken}`)).json()) as { rsvp: { status: string } };
      expect(oldLink.rsvp.status).toBe("NOT_FOUND");
      const newLink = (await (await context.request.get(`/api/v1/rsvp/${newToken}`)).json()) as { rsvp: { status: string } };
      expect(newLink.rsvp.status).toBe("OPEN");
    });

    await test.step("The owner can set the wedding's date and venue after creating it", async () => {
      const tab = new CollaboratorsTabPage(page);
      await tab.goto(w);
      await tab.saveDateAndVenue("2027-09-18", "Harbor Pavilion");
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      await expect(dashboard.weddingLink(managedWedding.name)).toContainText("9/18/2027");
      const { wedding } = (await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as {
        wedding: { eventDate: string; venueName: string };
      };
      expect(wedding).toMatchObject({ eventDate: "2027-09-18", venueName: "Harbor Pavilion" });
    });
  },
);
