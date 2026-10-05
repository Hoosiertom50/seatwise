/**
 * TS-174 (REQ-CLIENT-RSVP-COLLECTION, REQ-GUEST-LIST-MANAGEMENT) — RSVP links, party-size limits and
 * answers stay right when the guest list is re-imported, an email is corrected in two steps, or a
 * link changes while a guest is answering.
 * - Re-importing an export (party sizes unchanged) keeps the limit a guest's RSVP is held to; only
 *   a party size the import actually changes is the planner's new limit.
 * - Import "un-declines": a Declined guest the import sets to Confirmed or Pending is Attending
 *   again, waiting unseated -- the same as editing them -- and the plan's revision moves.
 * - Clearing a wrong email and then entering the right one sends a fresh link; the old one stops.
 * - An answer sent on a link that is regenerated (or whose guest is removed) while it's on its way
 *   is refused as an invalid link -- never saved, never a server error.
 * - Answers the form isn't showing are never saved: plus-ones once the party is down to one, and
 *   the party details when declining (they stay as they were) -- through the page and the API.
 * - "Their seat has been freed." only when the guest actually had one.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress } from "../data/ids.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";
import { holdWeddingLock } from "../support/testDatabase.js";

interface GuestState {
  headcount: number;
  plusOneNames: string | null;
  requiresAccessibleTable: boolean;
  rsvpStatus: string;
  dayOfAttendance: string;
  revision: number;
  email: string | null;
}

defineQualityTest(
  {
    id: "rsvp.links-limits-and-answers-hold-through-imports-and-races.reimport-undecline-email-race-hidden-fields",
    title: "re-imports keep RSVP limits and un-decline guests, a re-entered email gets a fresh link, a link changed mid-answer is refused, and hidden RSVP answers are never saved",
    objective:
      "Confirms that re-importing a guest with an unchanged party size keeps the larger limit their RSVP is held to while a changed party size becomes the new limit; that importing a Declined guest as Confirmed or Pending makes them Attending and unassigned and bumps the plan revision; that clearing a guest's email and entering a new one replaces their RSVP link so the old one is refused; that an RSVP held up while its link is regenerated, or its guest deleted, is refused with 404 and saves nothing; that plus-one names are not sent or stored once the party is one, and declining leaves the party details on file (page and API); and that a guest with no seat declining is not told a seat was freed.",
    expectedOutcome:
      "After an unchanged re-import the guest can still RSVP for 3 (200); after an import to 2, 3 is refused (422). Imported Confirmed/Pending: ATTENDING, in unassignedGuestIds, plan revision higher. Cleared-then-new email: a different link hash, old link POST 404, new link GET OPEN. Held RSVPs: 404 after regenerate and after delete, the guest's answer unchanged. Party of one: plusOneNames null in the request and on file. Declining: requiresAccessibleTable/headcount unchanged and not sent. Unseated decline notification ends \"can't make it.\".",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:rsvp", "@feature:guests", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, playwright, browser, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const person = () => uniquePersonName(testInfo.workerIndex);
    const guestOf = async (id: string) => ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: GuestState }).guest;
    const linkFor = async (guestId: string, regenerate = false) => {
      const res = await context.request.post(api(`guests/${guestId}/rsvp-link`), { data: { regenerate } });
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
    };
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const respond = (token: string, data: Record<string, unknown>) => visitor.post(`/api/v1/rsvp/${token}`, { data });
    const importCsv = async (csv: string, mapping: Record<string, string>) => {
      const res = await context.request.post(api("guests/import/commit"), { data: { csv, mapping } });
      expect(res.status(), await res.text()).toBe(200);
    };

    try {
      await test.step("Re-importing an unchanged party size keeps the RSVP limit; a changed one replaces it", async () => {
        const guest = await weddingData.createGuest(w, { ...person(), headcount: 3 });
        const token = await linkFor(guest.id);
        // The guest answers "just me" -- their limit stays 3.
        expect((await respond(token, { rsvpStatus: "CONFIRMED", headcount: 1 })).status()).toBe(200);
        const mapping = { guestId: "guestId", firstName: "firstName", lastName: "lastName", headcount: "headcount" };
        const row = (headcount: number) => `guestId,firstName,lastName,headcount\n${guest.id},${guest.firstName},${guest.lastName},${headcount}\n`;

        // An export re-imported as it is: headcount 1, unchanged.
        await importCsv(row(1), mapping);
        const preview = (await (await visitor.get(`/api/v1/rsvp/${token}`)).json()) as { rsvp: { maxHeadcount: number } };
        expect(preview.rsvp.maxHeadcount).toBe(3);
        expect((await respond(token, { rsvpStatus: "CONFIRMED", headcount: 3 })).status()).toBe(200);

        // A real change is the planner's new limit.
        await importCsv(row(2), mapping);
        expect((await respond(token, { rsvpStatus: "CONFIRMED", headcount: 3 })).status()).toBe(422);
        expect((await guestOf(guest.id)).headcount).toBe(2);
      });

      await test.step("Importing a Declined guest as Confirmed or Pending brings them back, unseated", async () => {
        await weddingData.createTable(w, { label: "Table 1", capacity: 20 });
        const toConfirm = await weddingData.createGuest(w, person());
        const toPending = await weddingData.createGuest(w, person());
        for (const g of [toConfirm, toPending]) {
          const current = await guestOf(g.id);
          const res = await context.request.patch(api(`guests/${g.id}`), { data: { rsvpStatus: "DECLINED", expectedRevision: current.revision } });
          expect(res.status()).toBe(200);
          expect((await guestOf(g.id)).dayOfAttendance).toBe("NOT_ATTENDING");
        }
        const plan = await weddingData.generatePlanVersion(w);
        const revisionBefore = (await weddingData.getPlanVersionDetail(w, plan.id)).revision;

        await importCsv(
          `guestId,firstName,lastName,rsvpStatus\n${toConfirm.id},${toConfirm.firstName},${toConfirm.lastName},CONFIRMED\n${toPending.id},${toPending.firstName},${toPending.lastName},PENDING\n`,
          { guestId: "guestId", firstName: "firstName", lastName: "lastName", rsvpStatus: "rsvpStatus" },
        );
        expect((await guestOf(toConfirm.id)).dayOfAttendance).toBe("ATTENDING");
        expect((await guestOf(toPending.id)).dayOfAttendance).toBe("ATTENDING");
        const after = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(after.unassignedGuestIds).toEqual(expect.arrayContaining([toConfirm.id, toPending.id]));
        expect(after.revision).toBeGreaterThan(revisionBefore);
      });

      await test.step("Clearing an email and entering a new one sends a fresh link; the old one stops working", async () => {
        const address = (label: string) => `pw-guest-${label}-${Date.now()}@example.invalid`;
        const guest = await weddingData.createGuest(w, { ...person(), email: address("wrong") });
        const oldToken = await linkFor(guest.id);
        let current = await guestOf(guest.id);
        expect((await context.request.patch(api(`guests/${guest.id}`), { data: { email: null, expectedRevision: current.revision } })).status()).toBe(200);
        current = await guestOf(guest.id);
        expect((await context.request.patch(api(`guests/${guest.id}`), { data: { email: address("right"), expectedRevision: current.revision } })).status()).toBe(200);
        const newToken = await linkFor(guest.id);
        expect(newToken).not.toBe(oldToken);
        expect((await respond(oldToken, { rsvpStatus: "CONFIRMED", headcount: 1 })).status()).toBe(404);
        const preview = (await (await visitor.get(`/api/v1/rsvp/${newToken}`)).json()) as { rsvp: { status: string } };
        expect(preview.rsvp.status).toBe("OPEN");
      });

      await test.step("An answer whose link is regenerated, or whose guest is removed, on its way is refused", async () => {
        const regenerated = await weddingData.createGuest(w, person());
        const removed = await weddingData.createGuest(w, person());
        const regeneratedToken = await linkFor(regenerated.id);
        const removedToken = await linkFor(removed.id);

        // Each answer is held at the wedding's lock -- after its link was looked up -- while the
        // link changes underneath it.
        let lock = await holdWeddingLock(w);
        let pending;
        try {
          pending = respond(regeneratedToken, { rsvpStatus: "DECLINED" });
          await lock.waitForWaiters(1);
          await linkFor(regenerated.id, true);
        } finally {
          await lock.release();
        }
        expect((await pending).status()).toBe(404);
        expect((await guestOf(regenerated.id)).rsvpStatus).toBe("PENDING");

        lock = await holdWeddingLock(w);
        try {
          pending = respond(removedToken, { rsvpStatus: "CONFIRMED", headcount: 1 });
          await lock.waitForWaiters(1);
          await weddingData.deleteGuest(w, removed.id);
        } finally {
          await lock.release();
        }
        expect((await pending).status()).toBe(404);
      });

      await test.step("Answers the form isn't showing are never saved (API)", async () => {
        const guest = await weddingData.createGuest(w, { ...person(), headcount: 2 });
        const token = await linkFor(guest.id);
        // A party of one has no plus-ones.
        expect((await respond(token, { rsvpStatus: "CONFIRMED", headcount: 1, plusOneNames: "Hidden Plusone" })).status()).toBe(200);
        expect((await guestOf(guest.id)).plusOneNames).toBeNull();
        // Declining leaves the party details as they were.
        expect((await respond(token, { rsvpStatus: "DECLINED", headcount: 2, plusOneNames: "Hidden Plusone", requiresAccessibleTable: true })).status()).toBe(200);
        const after = await guestOf(guest.id);
        expect(after.rsvpStatus).toBe("DECLINED");
        expect(after.headcount).toBe(1);
        expect(after.plusOneNames).toBeNull();
        expect(after.requiresAccessibleTable).toBe(false);
      });

      await test.step("Answers the form isn't showing are never sent or saved (page)", async () => {
        const guest = await weddingData.createGuest(w, { ...person(), headcount: 3 });
        const token = await linkFor(guest.id);
        const guestContext = await browser.newContext();
        try {
          const rsvp = new GuestRsvpPage(await guestContext.newPage());
          await rsvp.goto(token);
          await rsvp.choose("CONFIRMED");
          await rsvp.fillPartySize(2);
          await rsvp.fillPlusOneNames("Typed Then Dropped");
          await rsvp.fillPartySize(1);
          await expect(rsvp.plusOneNamesField()).toHaveCount(0);
          const sent = await rsvp.submitAsShown();
          expect(sent.plusOneNames ?? null).toBeNull();
          expect((await guestOf(guest.id)).plusOneNames).toBeNull();

          await rsvp.goto(token);
          await rsvp.choose("CONFIRMED");
          await rsvp.checkAccessibleSeat();
          await rsvp.choose("DECLINED");
          const declined = await rsvp.submitAsShown();
          expect(declined).not.toHaveProperty("requiresAccessibleTable");
          expect(declined).not.toHaveProperty("plusOneNames");
          const after = await guestOf(guest.id);
          expect(after.rsvpStatus).toBe("DECLINED");
          expect(after.requiresAccessibleTable).toBe(false);
        } finally {
          await guestContext.close();
        }
      });

      await test.step("A guest with no seat who declines isn't said to have freed one", async () => {
        const unseated = await weddingData.createGuest(w, person());
        const token = await linkFor(unseated.id);
        expect((await respond(token, { rsvpStatus: "DECLINED" })).status()).toBe(200);
        const { notifications } = (await (await context.request.get("/api/v1/notifications")).json()) as {
          notifications: { type: string; message: string }[];
        };
        const note = notifications.find((n) => n.type === "RSVP_RECEIVED" && n.message.includes(unseated.lastName))?.message;
        expect(note).toMatch(/can't make it\.$/);
      });
    } finally {
      await visitor.dispose();
    }
  },
);
