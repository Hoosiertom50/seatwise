/**
 * TS-167 (REQ-CLIENT-RSVP-COLLECTION) — Tom's decision, 2026-10-05: a guest who declines gives up
 * their seat. Declining through their RSVP link marks them Not Attending, which frees the seat
 * (and the planner's notification says so). If they confirm again later, they count as attending
 * again, unseated, until the planner seats them. A planner marking a guest Declined does the same.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress } from "../data/ids.js";

defineQualityTest(
  {
    id: "rsvp.declining-gives-up-the-seat.decline-reconfirm-and-planner-decline",
    title: "declining an RSVP frees the guest's seat, re-confirming puts them back as needing a seat, and a planner marking Declined frees it too",
    objective:
      "Confirms that a seated guest who declines through their link is no longer seated and is Not Attending, with a notification saying their seat was freed; that confirming again makes them Attending and unassigned, with a notification saying they need a seat; and that a planner setting a seated guest's RSVP to Declined frees that guest's seat.",
    expectedOutcome:
      "After the decline: no assignment for the guest, dayOfAttendance NOT_ATTENDING, the plan complete, and an RSVP_RECEIVED notification ending 'Their seat has been freed.'. After re-confirming: ATTENDING, listed in unassignedGuestIds, and a notification ending 'They need a seat.'. After the planner's Declined edit: the second guest has no assignment.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:rsvp", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, playwright }, testInfo) => {
    const w = managedWedding.id;
    const baseURL = testInfo.project.use.baseURL;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const other = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const plan = await weddingData.generatePlanVersion(w);
    expect(plan.assignments.map((a) => a.guestId).sort()).toEqual([guest.id, other.id].sort());

    const link = await context.request.post(`/api/v1/weddings/${w}/guests/${guest.id}/rsvp-link`, { data: {} });
    const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
    const visitor = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
    const respond = (rsvpStatus: string) => visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus, headcount: 1 } });
    const latestNoteFor = async () => {
      const { notifications } = (await (await context.request.get("/api/v1/notifications")).json()) as {
        notifications: { type: string; message: string }[];
      };
      return notifications.find((n) => n.type === "RSVP_RECEIVED" && n.message.includes(guest.lastName))?.message;
    };
    const attendanceOf = async (id: string) =>
      ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${id}`)).json()) as { guest: { dayOfAttendance: string } }).guest
        .dayOfAttendance;

    try {
      await test.step("Declining through the link frees the seat, and the planner is told", async () => {
        expect((await respond("DECLINED")).status()).toBe(200);
        const detail = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(detail.assignments.find((a) => a.guestId === guest.id)).toBeUndefined();
        expect(detail.isComplete).toBe(true);
        expect(await attendanceOf(guest.id)).toBe("NOT_ATTENDING");
        expect(await latestNoteFor()).toMatch(/can't make it\. Their seat has been freed\.$/);
      });

      await test.step("Confirming again counts them as attending, waiting for a seat", async () => {
        expect((await respond("CONFIRMED")).status()).toBe(200);
        const detail = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(detail.unassignedGuestIds).toContain(guest.id);
        expect(detail.isComplete).toBe(false);
        expect(await attendanceOf(guest.id)).toBe("ATTENDING");
        expect(await latestNoteFor()).toMatch(/is coming\. They need a seat\.$/);
      });
    } finally {
      await visitor.dispose();
    }

    await test.step("A planner marking a guest Declined frees their seat too", async () => {
      const current = ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${other.id}`)).json()) as { guest: { revision: number } }).guest;
      const res = await context.request.patch(`/api/v1/weddings/${w}/guests/${other.id}`, {
        data: { rsvpStatus: "DECLINED", expectedRevision: current.revision },
      });
      expect(res.status()).toBe(200);
      const detail = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(detail.assignments.find((a) => a.guestId === other.id)).toBeUndefined();
      expect(await attendanceOf(other.id)).toBe("NOT_ATTENDING");
    });
  },
);
