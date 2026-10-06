/**
 * TS-188 (REQ-AUTOMATED-SEAT-ASSIGNMENT, REQ-RELATIONSHIPS-SEATING-RULES, REQ-GUEST-LIST-MANAGEMENT)
 * — the seating engine and its rules, round 5:
 * - A locked table keeps the people already at it and seats nobody new -- not even a must-sit
 *   partner of someone there. The partner is left unseated with a warning saying what to do.
 * - A guest on a Restricted table's required-guest list can't be marked as needing an accessible
 *   table while that table isn't accessible -- by the planner's edit (422) or an import ("Nothing
 *   was imported").
 * - A Restricted table's list only counts guests who are Attending.
 * - Removing a seating rule answers with success once the rule is gone, even if re-checking the
 *   plan afterwards fails: the re-check is made to fail by holding the current plan's row lock
 *   from the test until the app's statement time limit runs out.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { holdPlanVersion } from "../support/testDatabase.js";

const SAVED_BUT_NOT_RECHECKED =
  "Saved, but the seating plan couldn't be re-checked just now — refresh the page to see the latest.";

defineQualityTest(
  {
    id: "seat-assignment.locked-tables-accessible-needs-and-rule-removal-hold.locked-accessible-attending-removal",
    title: "Locked tables take nobody new, a listed guest can't need an accessible seat their table lacks, lists count only Attending guests, and removing a rule never looks failed",
    objective:
      "Confirms that generating keeps a guest at their locked table and leaves their new must-sit partner unseated with a warning (never adding them there); that marking a guest on a non-accessible Restricted table's list as needing an accessible table is refused by the planner's edit and by an import, and allowed once the table is Accessible; that a Not Attending guest on a list doesn't count toward its seats, and the planner can't mark them attending again while that would overfill the list; and that removing a rule whose follow-up re-check fails still answers with success, a 'Saved, but…' warning, and the rule gone.",
    expectedOutcome:
      "The new plan has the guest at the locked table, the partner in unassignedGuestIds, a 'must sit with … is locked' warning, and isComplete false. The edit gets 422 naming the table and the import 422 'Nothing was imported', with the guest unchanged; after the table is made Accessible the edit gets 200. A list of a Not Attending party of 2 plus an Attending guest saves on a 1-seat table; marking that party Attending again gets 409 (attendance) / 422 (edit) naming \"VIP\" and they stay Not Attending. The rule removal gets 200 with ok true and the 'Saved, but…' warning, and the rule is no longer listed.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT", "REQ-RELATIONSHIPS-SEATING-RULES", "REQ-GUEST-LIST-MANAGEMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:tables", "@feature:relationships", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    test.setTimeout(120_000);
    const person = () => uniquePersonName(testInfo.workerIndex);
    const fullName = (g: { firstName: string; lastName: string }) => `${g.firstName} ${g.lastName}`;
    const newWedding = async (label: string) => (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, label))).id;
    const api = (w: string, path: string) => `/api/v1/weddings/${w}/${path}`;
    const errorOf = async (res: { json(): Promise<unknown> }) => ((await res.json()) as { error: string }).error;
    const guestNow = async (w: string, guestId: string) =>
      ((await (await context.request.get(api(w, `guests/${guestId}`))).json()) as { guest: { requiresAccessibleTable: boolean } }).guest;

    await test.step("A must-sit partner of someone at a locked table is left unseated, never added there", async () => {
      const w = managedWedding.id;
      const locked = await weddingData.createTable(w, { label: "Locked", capacity: 8 });
      const seated = await weddingData.createGuest(w, person());
      const first = await weddingData.generatePlanVersion(w);
      expect(first.assignments.find((a) => a.guestId === seated.id)?.tableId).toBe(locked.id);
      await weddingData.updateTable(w, locked.id, { isLocked: true });
      await weddingData.createTable(w, { label: "Open", capacity: 8 });
      const partner = await weddingData.createGuest(w, person());
      await weddingData.createRelationship(w, seated.id, partner.id, "MUST_SIT_TOGETHER");

      const plan = await weddingData.generatePlanVersion(w);
      expect(plan.assignments.find((a) => a.guestId === seated.id)?.tableId).toBe(locked.id);
      expect(plan.assignments.find((a) => a.guestId === partner.id)).toBeUndefined();
      expect(plan.unassignedGuestIds).toEqual([partner.id]);
      expect(plan.warnings.join("\n")).toContain(
        `Couldn't seat guest ${fullName(partner)} — they must sit with ${fullName(seated)}, but ${fullName(seated)}'s table "Locked" is locked. Unlock it or move them together.`,
      );
      expect(plan.isComplete).toBe(false);
    });

    await test.step("A listed guest can't be marked as needing an accessible seat their Restricted table lacks", async () => {
      const w = await newWedding("Accessible Need");
      const vip = await weddingData.createTable(w, { label: "VIP", capacity: 4, isRestricted: true });
      const listed = await weddingData.createGuest(w, person());
      const unlisted = await weddingData.createGuest(w, person());
      await weddingData.setRequiredGuests(w, vip.id, [listed.id]);

      const edit = await context.request.patch(api(w, `guests/${listed.id}`), { data: { requiresAccessibleTable: true } });
      expect(edit.status()).toBe(422);
      expect(await errorOf(edit)).toContain(`${fullName(listed)} is on "VIP"'s required-guest list, and "VIP" isn't marked Accessible`);
      expect((await guestNow(w, listed.id)).requiresAccessibleTable).toBe(false);

      const mapping = { guestId: "guestId", firstName: "firstName", lastName: "lastName", requiresAccessibleTable: "requiresAccessibleTable" };
      const csv = `guestId,firstName,lastName,requiresAccessibleTable\n${listed.id},${listed.firstName},${listed.lastName},yes\n`;
      const imported = await context.request.post(api(w, "guests/import/commit"), { data: { csv, mapping } });
      expect(imported.status()).toBe(422);
      expect(await errorOf(imported)).toContain(`Nothing was imported: ${fullName(listed)} is on "VIP"'s required-guest list`);
      expect((await guestNow(w, listed.id)).requiresAccessibleTable).toBe(false);

      // Someone who isn't on a list is unaffected, and once VIP is Accessible the edit is fine.
      const other = await context.request.patch(api(w, `guests/${unlisted.id}`), { data: { requiresAccessibleTable: true } });
      expect(other.status()).toBe(200);
      await weddingData.updateTable(w, vip.id, { isAccessible: true });
      const after = await context.request.patch(api(w, `guests/${listed.id}`), { data: { requiresAccessibleTable: true } });
      expect(after.status()).toBe(200);
      expect((await guestNow(w, listed.id)).requiresAccessibleTable).toBe(true);
    });

    await test.step("A Restricted table's list counts only guests who are Attending", async () => {
      const w = await newWedding("Attending Only");
      const vip = await weddingData.createTable(w, { label: "VIP", capacity: 1, isRestricted: true });
      const away = await weddingData.createGuest(w, { ...person(), headcount: 2 });
      const here = await weddingData.createGuest(w, person());
      const notAttending = await context.request.patch(api(w, `guests/${away.id}`), { data: { dayOfAttendance: "NOT_ATTENDING" } });
      expect(notAttending.status()).toBe(200);

      const list = await context.request.put(api(w, `tables/${vip.id}/required-guests`), { data: { guestIds: [away.id, here.id] } });
      expect(list.status()).toBe(200);

      // The planner can't then bring the party of 2 back: the list would need 3 seats at a 1-seat table.
      const back = await weddingData.setAttendance(w, away.id, "ATTENDING");
      expect(back.status).toBe(409);
      expect(back.body.error).toContain('"VIP"');
      const backByEdit = await context.request.patch(api(w, `guests/${away.id}`), { data: { dayOfAttendance: "ATTENDING" } });
      expect(backByEdit.status()).toBe(422);
      const stillAway = await context.request.get(api(w, `guests/${away.id}`));
      expect(((await stillAway.json()) as { guest: { dayOfAttendance: string } }).guest.dayOfAttendance).toBe("NOT_ATTENDING");
    });

    await test.step("Removing a rule answers with success even when the re-check afterwards fails", async () => {
      const w = await newWedding("Rule Removal");
      await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
      const a = await weddingData.createGuest(w, person());
      const b = await weddingData.createGuest(w, person());
      const rule = await weddingData.createRelationship(w, a.id, b.id, "PREFER_NEAR");
      const plan = await weddingData.generatePlanVersion(w);

      // The rule's removal doesn't need the plan's lock, but the re-check after it does -- hold it
      // until the app gives up waiting, so the re-check fails after the rule is already gone.
      const held = await holdPlanVersion(plan.id);
      try {
        const removing = context.request.delete(api(w, `relationships/${rule.id}`), { timeout: 90_000 });
        await held.waitForWaiters(1);
        const res = await removing;
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ ok: true, warnings: [SAVED_BUT_NOT_RECHECKED] });
      } finally {
        await held.release();
      }
      expect((await weddingData.listRelationships(w)).map((r) => r.id)).not.toContain(rule.id);
    });
  },
);
