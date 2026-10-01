/**
 * TS-134 (REQ-CLIENT-RSVP-COLLECTION) — a guest's own RSVP can change things their current seat
 * depends on: they can say they need an accessible seat, or bring more people. Before TS-134 the
 * RSVP saved those without re-checking the seat, so a guest could sit at a table that no longer
 * worked for them with nothing on the plan saying so. Now the seat is re-checked exactly as it is
 * after a planner's edit: they're flagged Needs Reassignment (never unseated), and the plan reads
 * as incomplete until someone moves them.
 *
 * The same capacity re-check now runs when a planner raises a seated guest's headcount.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { GuestRsvpPage } from "../pages/GuestRsvpPage.js";

defineQualityTest(
  {
    id: "rsvp.an-rsvp-that-no-longer-fits-the-seat-flags-it.accessible-and-headcount",
    title: "a guest's RSVP that needs an accessible seat or brings more people than their table holds flags them Needs Reassignment, and so does a planner raising a headcount",
    objective:
      "Confirms that a seated guest who says on their RSVP that they need an accessible seat, at a table that isn't accessible, is flagged Needs Reassignment and the plan becomes incomplete without anyone being unseated; that an RSVP bringing more people than the table has room for flags someone at that table; that a planner lowering the headcount again clears it; and that a planner raising a seated guest's headcount past the table's room returns a 'no longer fits' warning.",
    expectedOutcome:
      "After the accessible RSVP, that guest is still at 'Floor' but flagged, and isComplete is false. After the headcount-2 RSVP at the full two-seat 'Snug', one guest there is flagged and both are still seated. The planner setting headcount back to 1 clears the flag at Snug. The planner raising it to 3 gets a warning ending 'no longer fits at their table — flagged as Needs Reassignment.'.",
    requirementIds: ["REQ-CLIENT-RSVP-COLLECTION"],
    tags: ["@mutating", "@feature:rsvp", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    const w = managedWedding.id;
    const [g, h, i, j] = Array.from({ length: 4 }, () => uniquePersonName(testInfo.workerIndex));
    const guests = await Promise.all([g, h, i, j].map((n) => weddingData.createGuest(w, n)));
    const [gId, hId, iId, jId] = guests.map((x) => x.id);
    const floor = await weddingData.createTable(w, { label: "Floor", capacity: 2 });
    const snug = await weddingData.createTable(w, { label: "Snug", capacity: 2 });
    const plan = await weddingData.generatePlanVersion(w);
    for (const [id, t] of [[gId, floor.id], [hId, floor.id], [iId, snug.id], [jId, snug.id]] as const) {
      await weddingData.moveGuestAssignment(w, plan.id, id, t);
    }
    const detail = () => weddingData.getPlanVersionDetail(w, plan.id);
    expect((await detail()).isComplete).toBe(true);

    const rsvpAs = async (guestId: string, input: Parameters<GuestRsvpPage["submit"]>[0]) => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/${guestId}/rsvp-link`, { data: {} });
      expect(res.ok()).toBe(true);
      const token = ((await res.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
      const guestContext = await browser.newContext();
      try {
        const rsvp = new GuestRsvpPage(await guestContext.newPage());
        await rsvp.goto(token);
        await rsvp.submit(input);
      } finally {
        await guestContext.close();
      }
    };

    await test.step("An RSVP that needs an accessible seat flags the guest at a table that isn't accessible", async () => {
      await rsvpAs(gId, { attending: "CONFIRMED", requiresAccessibleTable: true });
      const d = await detail();
      const a = d.assignments.find((x) => x.guestId === gId)!;
      expect(a.tableId).toBe(floor.id);
      expect(a.needsReassignment).toBe(true);
      expect(d.isComplete).toBe(false);
    });

    await test.step("An RSVP bringing more people than the table holds flags someone there, and nobody is unseated", async () => {
      await rsvpAs(jId, { attending: "CONFIRMED", headcount: 2 });
      const atSnug = (await detail()).assignments.filter((x) => x.tableId === snug.id);
      expect(atSnug.map((x) => x.guestId).sort()).toEqual([iId, jId].sort());
      expect(atSnug.filter((x) => x.needsReassignment)).toHaveLength(1);
    });

    await test.step("A planner lowering the headcount again clears the flag", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${w}/guests/${jId}`, { data: { headcount: 1 } });
      expect(res.ok()).toBe(true);
      const atSnug = (await detail()).assignments.filter((x) => x.tableId === snug.id);
      expect(atSnug.filter((x) => x.needsReassignment)).toHaveLength(0);
    });

    await test.step("A planner raising a seated guest's headcount past the table's room gets a warning", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${w}/guests/${iId}`, { data: { headcount: 3 } });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings.join("\n")).toMatch(/no longer fits at their table — flagged as Needs Reassignment\./);
      const atSnug = (await detail()).assignments.filter((x) => x.tableId === snug.id);
      expect(atSnug).toHaveLength(2);
      expect(atSnug.filter((x) => x.needsReassignment)).toHaveLength(1);
    });
  },
);
