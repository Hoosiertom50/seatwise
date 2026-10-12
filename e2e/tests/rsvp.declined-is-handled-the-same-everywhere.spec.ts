/**
 * TS-169 (REQ-CLIENT-RSVP-COLLECTION) — "declining gives up the seat" (TS-167) holds on every path,
 * and only a real change of answer moves a guest's attendance.
 * - A guest added (or imported) as Declined is Not Attending and gets no seat from Generate.
 * - A guest re-sending the same answer through their link (to fix a detail) leaves the planner's
 *   own attendance setting alone.
 * - A planner switching a guest from Declined back to Confirmed brings them back: Attending, unseated.
 * - A CSV import, or deleting a seated guest, on an approved plan shows "Modified since approval".
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueTitle } from "../data/ids.js";
import type { PlanVersionDetail } from "../data/api.js";

defineQualityTest(
  {
    id: "rsvp.declined-is-handled-the-same-everywhere.add-import-resend-switch-back-history",
    title: "Declined means Not Attending on every path, only a real change of answer moves attendance, and imports or deletions on an approved plan show as modified",
    objective:
      "Confirms that a guest added as Declined, and one imported as Declined, are Not Attending and unseated after Generate; that a guest re-sending Confirmed keeps the Not Attending the planner set; that the planner changing a Declined guest to Confirmed makes them Attending and unassigned; and that an import adding a guest, and deleting a seated guest, each make an approved plan show Modified since approval.",
    expectedOutcome:
      "Both Declined guests: dayOfAttendance NOT_ATTENDING and no seat. Re-sent Confirmed: still NOT_ATTENDING. Switched back: ATTENDING and in unassignedGuestIds. modifiedSinceApproval.active true after the import, and true after the delete on a freshly approved plan.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:rsvp", "@feature:guests", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, playwright }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const person = () => uniquePersonName(testInfo.workerIndex);
    const guestOf = async (id: string) =>
      ((await (await context.request.get(api(`guests/${id}`))).json()) as { guest: { dayOfAttendance: string; revision: number; rsvpStatus: string } }).guest;
    const mapping = { firstName: "firstName", lastName: "lastName", rsvpStatus: "rsvpStatus" };
    await weddingData.createTable(w, { label: "Table 1", capacity: 10 });

    await test.step("Added or imported as Declined: Not Attending, and Generate gives no seat", async () => {
      const added = (await (await context.request.post(api("guests"), { data: { ...person(), rsvpStatus: "DECLINED" } })).json()) as {
        guest: { id: string };
      };
      const imported = person();
      const res = await context.request.post(api("guests/import/commit"), {
        data: { csv: `firstName,lastName,rsvpStatus\n${imported.firstName},${imported.lastName},DECLINED\n`, mapping },
      });
      expect(res.ok()).toBe(true);
      const importedId = (await weddingData.listGuests(w)).find((g) => g.lastName === imported.lastName)!.id;
      expect((await guestOf(added.guest.id)).dayOfAttendance).toBe("NOT_ATTENDING");
      expect((await guestOf(importedId)).dayOfAttendance).toBe("NOT_ATTENDING");
      const plan = await weddingData.generatePlanVersion(w);
      const seated = plan.assignments.map((a) => a.guestId);
      expect(seated).not.toContain(added.guest.id);
      expect(seated).not.toContain(importedId);
    });

    await test.step("Re-sending the same answer keeps the planner's attendance setting", async () => {
      const guest = await weddingData.createGuest(w, person());
      const link = await context.request.post(api(`guests/${guest.id}/rsvp-link`), { data: {} });
      const token = ((await link.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const visitor = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() } });
      try {
        const confirm = () => visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "CONFIRMED", headcount: 1, plusOneNames: null } });
        expect((await confirm()).status()).toBe(200);
        expect((await weddingData.setAttendance(w, guest.id, "NOT_ATTENDING")).status).toBe(200);
        expect((await confirm()).status()).toBe(200);
        expect((await guestOf(guest.id)).dayOfAttendance).toBe("NOT_ATTENDING");
      } finally {
        await visitor.dispose();
      }
    });

    await test.step("The planner switching Declined back to Confirmed brings the guest back, unseated", async () => {
      const guest = await weddingData.createGuest(w, person());
      let current = await guestOf(guest.id);
      expect((await context.request.patch(api(`guests/${guest.id}`), { data: { rsvpStatus: "DECLINED", expectedRevision: current.revision } })).status()).toBe(200);
      expect((await guestOf(guest.id)).dayOfAttendance).toBe("NOT_ATTENDING");
      current = await guestOf(guest.id);
      expect((await context.request.patch(api(`guests/${guest.id}`), { data: { rsvpStatus: "CONFIRMED", expectedRevision: current.revision } })).status()).toBe(200);
      expect((await guestOf(guest.id)).dayOfAttendance).toBe("ATTENDING");
      const plan = (await weddingData.listPlanVersions(w)).find((v) => v.isCurrent)!;
      expect((await weddingData.getPlanVersionDetail(w, plan.id)).unassignedGuestIds).toContain(guest.id);
    });

    await test.step("An import or a deletion on an approved plan shows as modified", async () => {
      const w2 = (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Approved History"))).id;
      await weddingData.createTable(w2, { label: "Table 1", capacity: 10 });
      const seatedGuest = await weddingData.createGuest(w2, person());
      const approve = async (): Promise<PlanVersionDetail> => {
        const plan = await weddingData.generatePlanVersion(w2);
        expect((await weddingData.setPlanVersionStatus(w2, plan.id, "IN_REVIEW")).status).toBe(200);
        expect((await weddingData.setPlanVersionStatus(w2, plan.id, "APPROVED")).status).toBe(200);
        return plan;
      };

      let plan = await approve();
      const newcomer = person();
      const res = await context.request.post(`/api/v1/weddings/${w2}/guests/import/commit`, {
        data: { csv: `firstName,lastName\n${newcomer.firstName},${newcomer.lastName}\n`, mapping: { firstName: "firstName", lastName: "lastName" } },
      });
      expect(res.ok()).toBe(true);
      expect((await weddingData.getPlanVersionDetail(w2, plan.id)).modifiedSinceApproval.active).toBe(true);

      // A fresh approval, then delete the seated guest.
      const newcomerId = (await weddingData.listGuests(w2)).find((g) => g.lastName === newcomer.lastName)!.id;
      await weddingData.deleteGuest(w2, newcomerId);
      plan = await approve();
      expect((await weddingData.getPlanVersionDetail(w2, plan.id)).modifiedSinceApproval.active).toBe(false);
      await weddingData.deleteGuest(w2, seatedGuest.id);
      expect((await weddingData.getPlanVersionDetail(w2, plan.id)).modifiedSinceApproval.active).toBe(true);
    });
  },
);
