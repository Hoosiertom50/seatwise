/**
 * TS-42 (REQ-RELATIONSHIPS-SEATING-RULES) — converts AC-032 ("Accessible-seating requirement is
 * enforced as a hard rule").
 *
 * The manual-move-blocking half of this AC -- moving a Requires-Accessible-Table guest to a
 * non-accessible table is refused -- is already fully covered by TS-54's
 * cross-cutting-invariant.hard-rules-block-every-direct-manual-move.spec.ts. Not re-authored here.
 * "Import, restoration, or day-of" aren't separate placement code paths from generation/manual-
 * move -- a guest created via CSV import or a plan restored from history still lands through the
 * same generate/move logic already proven elsewhere, so there's nothing distinct to exercise for
 * those beyond what's already covered.
 *
 * What's new here: whether *generation itself* ever seats a guest who requires an accessible
 * table anywhere but an Accessible table (the hard feasibility filter in `attemptPlace`,
 * seating-engine.ts: `if (unit.requiresAccessible && !t.isAccessible) return false` -- checked
 * before any scoring, never violated even if it leaves the guest unassigned) -- and that free-text
 * accessibility notes alone never trigger that restriction for a guest whose
 * requiresAccessibleTable flag is false, letting them be seated at a non-accessible table exactly
 * like anyone else.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniqueToken } from "../data/ids.js";

defineQualityTest(
  {
    id: "rules.accessible-seating-requirement-is-enforced-as-a-hard-rule.generation-honors-the-flag-not-the-notes",
    title: "generation seats a Requires-Accessible-Table guest only at an Accessible table, while a guest with accessibility notes but no flag can land anywhere",
    objective:
      "Confirms that generation places a guest who requires an accessible table only at a table marked Accessible, and places a guest whose only accessibility signal is free-text notes (with the requiresAccessibleTable flag left false) wherever ordinary placement puts them, including a non-accessible table.",
    expectedOutcome:
      "The Requires-Accessible-Table guest is seated at the Accessible table; the guest with notes-only is seated at the non-Accessible table (the only seat left); the plan is complete.",
    requirementIds: ["REQ-RELATIONSHIPS-SEATING-RULES"],
    tags: ["@mutating", "@feature:relationships", "@feature:tables", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let idRequiresAccessible = "";
    let idNotesOnly = "";
    let accessibleTableId = "";
    let standardTableId = "";

    await test.step("Arrange: one guest who requires an accessible table, one guest with only free-text accessibility notes (flag left false); one Accessible and one non-Accessible table, each with exactly one seat", async () => {
      // Last names are chosen (rather than uniquePersonName's identical "Tester-..." pattern for
      // both) so the app's own guest-list ordering (ORDER BY lastName, firstName) is guaranteed
      // to process the Requires-Accessible-Table guest first -- with only one seat at each table,
      // this is the one thing that decides whether the *other* guest's ordinary tie-break could
      // ever accidentally grab the Accessible table first and starve the guest who actually needs
      // it, which would make the plan incomplete instead of proving this AC.
      const token = uniqueToken(testInfo.workerIndex);
      idRequiresAccessible = (
        await weddingData.createGuest(managedWedding.id, {
          firstName: "Playwright",
          lastName: `AccessNeeded-${token}`,
          requiresAccessibleTable: true,
        })
      ).id;
      idNotesOnly = (
        await weddingData.createGuest(managedWedding.id, {
          firstName: "Playwright",
          lastName: `ZNotesOnly-${token}`,
          requiresAccessibleTable: false,
          notes: "Uses a wheelchair, but the couple confirmed no table accommodation is required.",
        })
      ).id;
      accessibleTableId = (
        await weddingData.createTable(managedWedding.id, { label: "Access Table", capacity: 1, isAccessible: true })
      ).id;
      standardTableId = (
        await weddingData.createTable(managedWedding.id, { label: "Standard Table", capacity: 1 })
      ).id;
    });

    await test.step("Act + Assert: generation seats the Requires-Accessible-Table guest at the Accessible table and the notes-only guest at the standard table, complete", async () => {
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        planVersion: { isComplete: boolean; assignments: { guestId: string; tableId: string }[] };
      };
      expect(body.planVersion.isComplete).toBe(true);
      const tableOf = (id: string) => body.planVersion.assignments.find((a) => a.guestId === id)?.tableId;
      expect(tableOf(idRequiresAccessible)).toBe(accessibleTableId);
      expect(tableOf(idNotesOnly)).toBe(standardTableId);
    });
  },
);
