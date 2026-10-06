/**
 * TS-181 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — the seating plan stays consistent, round 4.
 * - A table edit and its required-guest list are saved together or not at all: a list that can't
 *   be saved no longer leaves the table's other changes (like fewer seats) in place.
 * - A Restricted table's list can't hold a guest who needs an accessible seat at a table that isn't
 *   accessible, or two guests who must not sit together; and later changes that would make the list
 *   impossible are refused (a bigger party by the planner or an import, Accessible switched off, a
 *   new must-not rule) -- or, for the guest's own RSVP, flagged for the planner.
 * - A rule that contradicts a chain of must-sit-together rules is refused when it's added, naming
 *   the guests.
 * - Removing a table re-checks the tables of the guests it unseats' rule partners.
 * - Approving re-checks every table itself rather than trusting the stored flags.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTestAddress, uniqueTitle } from "../data/ids.js";
import { plantStaleSeatFlags } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "seat-assignment.restricted-lists-rules-and-removals-keep-the-plan-consistent.list-rules-removal-approval",
    title: "Table edits and their lists save together, lists stay possible, rule chains are refused, removing a table and approving re-check the seating",
    objective:
      "Confirms that a table edit whose required-guest list can't be saved saves nothing (seat count and label unchanged); that a list with an accessible-needing guest at a non-accessible table, or two must-not-sit-together guests, is refused; that a planner edit or import growing a listed guest's party past the table is refused, the guest's own RSVP is accepted and flags the table, switching Accessible off under a list that needs it is refused, and a must-not rule between two listed guests is refused; that a rule contradicting a must-sit-together chain is refused naming the guests; that removing a table clears a must-sit partner's flag elsewhere; and that approving a plan whose flags went stale flags the guest again and refuses.",
    expectedOutcome:
      "The combined edit gets 422 and the table still has 4 seats and its old label; the bad lists get 422/409 with plain messages; the party-size edit and import get 422, the RSVP 200 with a flag at the table; Accessible off gets 422; the must-not rules get 409 naming the guests (and the chain); after the removal the partner's flag is cleared; the approval gets 409 and the over-capacity guest is flagged again.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT", "REQ-RELATIONSHIPS-SEATING-RULES", "REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:tables", "@feature:relationships", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, playwright }, testInfo) => {
    test.setTimeout(120_000);
    const person = () => uniquePersonName(testInfo.workerIndex);
    const fullName = (g: { firstName: string; lastName: string }) => `${g.firstName} ${g.lastName}`;
    const newWedding = async (label: string) => (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, label))).id;
    const api = (w: string, path: string) => `/api/v1/weddings/${w}/${path}`;
    const errorOf = async (res: { json(): Promise<unknown> }) => ((await res.json()) as { error: string }).error;
    const tableNow = async (w: string, tableId: string) => (await weddingData.listTables(w)).find((t) => t.id === tableId)!;
    const visitor = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { "x-forwarded-for": uniqueTestAddress() },
    });

    try {
      await test.step("A table edit whose list can't be saved saves nothing at all", async () => {
        const w = managedWedding.id;
        const vip = await weddingData.createTable(w, { label: "VIP", capacity: 4, isRestricted: true });
        const a = await weddingData.createGuest(w, person());
        const b = await weddingData.createGuest(w, person());
        const c = await weddingData.createGuest(w, person());
        await weddingData.setRequiredGuests(w, vip.id, [a.id]);

        // Two seats, but a list that needs three: refused, and neither the seats nor the label change.
        const bad = await context.request.patch(api(w, `tables/${vip.id}`), {
          data: { label: "Top Table", capacity: 2, requiredGuestIds: [a.id, b.id, c.id] },
        });
        expect(bad.status()).toBe(422);
        expect(await errorOf(bad)).toContain('This list needs 3 seat(s), but "Top Table" only has 2.');
        const after = await tableNow(w, vip.id);
        expect(after.capacity).toBe(4);
        expect(after.label).toBe("VIP");
        expect(after.requiredGuestIds).toEqual([a.id]);

        // Fewer seats and a shorter list in one edit is fine -- checked against each other.
        const good = await context.request.patch(api(w, `tables/${vip.id}`), {
          data: { capacity: 2, requiredGuestIds: [a.id, b.id] },
        });
        expect(good.status()).toBe(200);
        const saved = await tableNow(w, vip.id);
        expect(saved.capacity).toBe(2);
        expect([...saved.requiredGuestIds].sort()).toEqual([a.id, b.id].sort());
      });

      await test.step("A list can't hold a guest needing an accessible seat at a non-accessible table, or a must-not pair", async () => {
        const w = await newWedding("List Validity");
        const vip = await weddingData.createTable(w, { label: "VIP", capacity: 4, isRestricted: true });
        const needsRamp = await weddingData.createGuest(w, { ...person(), requiresAccessibleTable: true });
        const x = await weddingData.createGuest(w, person());
        const y = await weddingData.createGuest(w, person());
        await weddingData.createRelationship(w, x.id, y.id, "MUST_NOT_SIT_TOGETHER");

        const ramp = await context.request.put(api(w, `tables/${vip.id}/required-guests`), { data: { guestIds: [needsRamp.id] } });
        expect(ramp.status()).toBe(409);
        expect(await errorOf(ramp)).toContain(`${fullName(needsRamp)} needs an accessible table, and "VIP" isn't marked Accessible`);

        const apart = await context.request.patch(api(w, `tables/${vip.id}`), { data: { requiredGuestIds: [x.id, y.id] } });
        expect(apart.status()).toBe(422);
        expect(await errorOf(apart)).toContain(`must not sit together, so they can't both be on "VIP"'s required-guest list`);
        expect((await tableNow(w, vip.id)).requiredGuestIds).toEqual([]);

        // Accessible and the list in one edit: fine.
        const both = await context.request.patch(api(w, `tables/${vip.id}`), { data: { isAccessible: true, requiredGuestIds: [needsRamp.id] } });
        expect(both.status()).toBe(200);
        // ...and Accessible can't then be switched off under them.
        const off = await context.request.patch(api(w, `tables/${vip.id}`), { data: { isAccessible: false } });
        expect(off.status()).toBe(422);
        expect(await errorOf(off)).toContain(`"VIP" has to stay Accessible: ${fullName(needsRamp)}`);
        expect((await tableNow(w, vip.id)).isAccessible).toBe(true);
      });

      await test.step("Later changes can't make a list impossible: bigger parties, a new must-not rule; an RSVP is flagged instead", async () => {
        const w = await newWedding("List Later Changes");
        await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
        const vip = await weddingData.createTable(w, { label: "VIP", capacity: 2, isRestricted: true });
        // Invited as a party of two; answers "just me" for now, so their limit stays two.
        const listed = await weddingData.createGuest(w, { ...person(), headcount: 2 });
        const other = await weddingData.createGuest(w, person());
        const linkRes = await context.request.post(api(w, `guests/${listed.id}/rsvp-link`), { data: {} });
        const token = ((await linkRes.json()) as { rsvp: { url: string } }).rsvp.url.split("/").pop()!;
        const rsvp = (headcount: number) =>
          visitor.post(`/api/v1/rsvp/${token}`, { data: { rsvpStatus: "CONFIRMED", headcount, plusOneNames: null } });
        expect((await rsvp(1)).status()).toBe(200);
        await weddingData.setRequiredGuests(w, vip.id, [listed.id, other.id]);

        const grow = await context.request.patch(api(w, `guests/${other.id}`), { data: { headcount: 2 } });
        expect(grow.status()).toBe(422);
        expect(await errorOf(grow)).toContain(`is on "VIP"'s required-guest list, and a party of 2 would need 3 seats there — it has 2`);

        const mapping = { guestId: "guestId", firstName: "firstName", lastName: "lastName", headcount: "headcount" };
        const csv = `guestId,firstName,lastName,headcount\n${other.id},${other.firstName},${other.lastName},3\n`;
        const imported = await context.request.post(api(w, "guests/import/commit"), { data: { csv, mapping } });
        expect(imported.status()).toBe(422);
        expect(await errorOf(imported)).toContain("Nothing was imported");
        const otherNow = await context.request.get(api(w, `guests/${other.id}`));
        expect(((await otherNow.json()) as { guest: { headcount: number } }).guest.headcount).toBe(1);

        const rule = await context.request.post(api(w, "relationships"), {
          data: { guestAId: listed.id, guestBId: other.id, type: "MUST_NOT_SIT_TOGETHER" },
        });
        expect(rule.status()).toBe(409);
        expect(await errorOf(rule)).toContain(`are both on "VIP"'s required-guest list`);

        // The guest's own answer is never refused -- the table is re-checked and someone at it is flagged.
        const plan = await weddingData.generatePlanVersion(w);
        expect(plan.assignments.filter((a) => a.tableId === vip.id)).toHaveLength(2);
        expect((await rsvp(2)).status()).toBe(200);
        const detail = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(detail.assignments.filter((a) => a.tableId === vip.id && a.needsReassignment)).toHaveLength(1);
        expect(detail.isComplete).toBe(false);
      });

      await test.step("A rule that contradicts a chain of must-sit-together rules is refused, naming the guests", async () => {
        const w = await newWedding("Rule Chains");
        const a = await weddingData.createGuest(w, person());
        const b = await weddingData.createGuest(w, person());
        const c = await weddingData.createGuest(w, person());
        const d = await weddingData.createGuest(w, person());
        await weddingData.createRelationship(w, a.id, b.id, "MUST_SIT_TOGETHER");
        await weddingData.createRelationship(w, b.id, c.id, "MUST_SIT_TOGETHER");

        const mustNot = await context.request.post(api(w, "relationships"), { data: { guestAId: a.id, guestBId: c.id, type: "MUST_NOT_SIT_TOGETHER" } });
        expect(mustNot.status()).toBe(409);
        const message = await errorOf(mustNot);
        for (const g of [a, b, c]) expect(message).toContain(fullName(g));
        expect(message).toContain("would always seat them at the same table");

        // The other way round: a must-not rule first, then the must-sit link that would close the chain.
        await weddingData.createRelationship(w, c.id, d.id, "MUST_NOT_SIT_TOGETHER");
        const closing = await context.request.post(api(w, "relationships"), { data: { guestAId: a.id, guestBId: d.id, type: "MUST_SIT_TOGETHER" } });
        expect(closing.status()).toBe(409);
        const closingMessage = await errorOf(closing);
        for (const g of [a, b, c, d]) expect(closingMessage).toContain(fullName(g));
        expect(closingMessage).toContain(" → ");
        expect(await weddingData.listRelationships(w)).toHaveLength(3);
      });

      await test.step("Removing a table re-checks where the guests it unseats' rule partners sit", async () => {
        const w = await newWedding("Remove Table");
        const t1 = await weddingData.createTable(w, { label: "Table 1", capacity: 1 });
        await weddingData.createTable(w, { label: "Table 2", capacity: 1 });
        const a = await weddingData.createGuest(w, person());
        const b = await weddingData.createGuest(w, person());
        const plan = await weddingData.generatePlanVersion(w);
        // One seat per table, so they're apart; a must-sit-together rule then flags them both.
        await weddingData.createRelationship(w, a.id, b.id, "MUST_SIT_TOGETHER");
        const flagged = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(flagged.assignments.filter((s) => s.needsReassignment)).toHaveLength(2);

        const atT1 = flagged.assignments.find((s) => s.tableId === t1.id)!.guestId;
        const partner = atT1 === a.id ? b.id : a.id;
        const removed = await context.request.delete(api(w, `tables/${t1.id}?confirm=true`));
        expect(removed.status()).toBe(200);
        const after = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(after.assignments.map((s) => s.guestId)).toEqual([partner]);
        expect(after.assignments[0].needsReassignment).toBe(false);
        expect(after.unassignedGuestIds).toEqual([atT1]);
      });

      await test.step("Approving re-checks every table instead of trusting the stored flags", async () => {
        const w = await newWedding("Approval Recheck");
        const t1 = await weddingData.createTable(w, { label: "Table 1", capacity: 3 });
        for (let i = 0; i < 3; i++) await weddingData.createGuest(w, person());
        const plan = await weddingData.generatePlanVersion(w);
        await weddingData.updateTable(w, t1.id, { capacity: 2 });
        // As if the edit's own re-check had never run.
        await plantStaleSeatFlags(w, plan.id);
        expect((await weddingData.getPlanVersionDetail(w, plan.id)).isComplete).toBe(true);

        const approve = await weddingData.setPlanVersionStatus(w, plan.id, "APPROVED");
        expect(approve.status).toBe(409);
        expect(approve.body.error).toContain("can't be approved yet");
        const detail = await weddingData.getPlanVersionDetail(w, plan.id);
        expect(detail.status).not.toBe("APPROVED");
        expect(detail.assignments.filter((s) => s.needsReassignment)).toHaveLength(1);
        expect(detail.isComplete).toBe(false);
      });
    } finally {
      await visitor.dispose();
    }
  },
);
