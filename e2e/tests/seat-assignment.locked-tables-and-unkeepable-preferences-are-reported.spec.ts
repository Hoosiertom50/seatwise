/**
 * TS-117 (REQ-AUTOMATED-SEAT-ASSIGNMENT) — three generator behaviours the coverage audit found
 * untested (packages/shared/src/seating-engine.ts):
 *
 * 1. A locked *table* is reserved: generation never fills it with guests who weren't already
 *    there, even when that leaves someone unseated -- it says so instead.
 * 2. A locked *guest* whose table can no longer be kept (a new must-not-sit-together rule with
 *    someone else locked there) is seated elsewhere automatically, with a warning naming them and
 *    the table -- never left stranded, never silently moved.
 * 3. When an "avoid" preference can't be honoured (only one table has room), the pair is seated
 *    together with a warning rather than one of them being left out.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "seat-assignment.locked-tables-and-unkeepable-preferences-are-reported.locked-table-pin-fallback-avoid-fallback",
    title: "generation keeps locked tables for their own guests, and seats a locked guest or an avoid pair elsewhere or together only with a warning saying so",
    objective:
      "Confirms that a locked table receives no new guests even when that leaves one unseated (and the plan is incomplete with that guest reported), that a locked guest whose table now breaks a hard rule is seated at another table with a 'locked to \"<table>\", but that's no longer possible' warning, and that an avoid pair forced to share the only table is seated together with an 'avoid' warning.",
    expectedOutcome:
      "Locked table: the two new guests fill the open two-seat table, the third is unassigned, nobody new is at the locked table, and isComplete is false. Locked guest: after a must-not rule with the other locked guest, one of them is at the new table and the warnings name them as locked to \"Head\". Avoid: both guests sit at the only table and a warning says they were seated together despite an avoid preference.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const name = () => uniquePersonName(testInfo.workerIndex);
    const fullName = (g: { firstName: string; lastName: string }) => `${g.firstName} ${g.lastName}`;
    const lock = async (guestId: string) =>
      expect((await context.request.patch(`/api/v1/weddings/${w}/guests/${guestId}`, { data: { isLocked: true } })).ok()).toBe(true);

    await test.step("A locked table takes no new guests, even if that leaves one unseated", async () => {
      const locked = await weddingData.createTable(w, { label: "Reserved", capacity: 8, isLocked: true });
      const open = await weddingData.createTable(w, { label: "Open", capacity: 2 });
      const guests = [await weddingData.createGuest(w, name()), await weddingData.createGuest(w, name()), await weddingData.createGuest(w, name())];

      const plan = await weddingData.generatePlanVersion(w);
      expect(plan.assignments.filter((a) => a.tableId === locked.id)).toHaveLength(0);
      expect(plan.assignments.filter((a) => a.tableId === open.id)).toHaveLength(2);
      expect(plan.unassignedGuestIds).toHaveLength(1);
      expect(guests.map((g) => g.id)).toContain(plan.unassignedGuestIds[0]);
      expect(plan.isComplete).toBe(false);

      for (const g of guests) await weddingData.deleteGuest(w, g.id);
      await context.request.delete(`/api/v1/weddings/${w}/tables/${locked.id}?confirm=true`);
      await context.request.delete(`/api/v1/weddings/${w}/tables/${open.id}?confirm=true`);
    });

    await test.step("A locked guest who can't keep their table is seated elsewhere, with a warning naming them", async () => {
      const head = await weddingData.createTable(w, { label: "Head", capacity: 2 });
      const g = await weddingData.createGuest(w, name());
      const h = await weddingData.createGuest(w, name());
      const first = await weddingData.generatePlanVersion(w);
      expect(first.assignments.filter((a) => a.tableId === head.id)).toHaveLength(2);
      await lock(g.id);
      await lock(h.id);

      const side = await weddingData.createTable(w, { label: "Side", capacity: 2 });
      await weddingData.createRelationship(w, g.id, h.id, "MUST_NOT_SIT_TOGETHER");
      const second = await weddingData.generatePlanVersion(w);

      const tableOf = (guestId: string) => second.assignments.find((a) => a.guestId === guestId)?.tableId;
      expect(new Set([tableOf(g.id), tableOf(h.id)])).toEqual(new Set([head.id, side.id]));
      const moved = tableOf(g.id) === side.id ? g : h;
      expect(second.warnings.join("\n")).toContain(`Guest ${fullName(moved)} is locked to "Head", but that's no longer possible — seated automatically instead.`);
      expect(second.isComplete).toBe(true);

      for (const x of [g, h]) await weddingData.deleteGuest(w, x.id);
      for (const t of [head, side]) await context.request.delete(`/api/v1/weddings/${w}/tables/${t.id}?confirm=true`);
    });

    await test.step("An avoid pair with only one table that fits is seated together, with a warning", async () => {
      const only = await weddingData.createTable(w, { label: "Only", capacity: 2 });
      const a = await weddingData.createGuest(w, name());
      const b = await weddingData.createGuest(w, name());
      await weddingData.createRelationship(w, a.id, b.id, "AVOID");

      const plan = await weddingData.generatePlanVersion(w);
      expect(plan.assignments.filter((x) => x.tableId === only.id).map((x) => x.guestId).sort()).toEqual([a.id, b.id].sort());
      expect(plan.isComplete).toBe(true);
      expect(plan.warnings.join("\n")).toMatch(/were seated at the same table despite an "avoid" preference between them/);
      expect(plan.warnings.join("\n")).toContain(fullName(a));
      expect(plan.warnings.join("\n")).toContain(fullName(b));
    });
  },
);
