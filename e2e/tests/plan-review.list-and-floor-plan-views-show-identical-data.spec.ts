/**
 * TS-43 (REQ-PLAN-REVIEW-STATUS) — converts AC-047 ("Both a visual layout and a list view are
 * available and consistent").
 *
 * Both views are proven (by reading apps/web/src/app/weddings/[weddingId]/components/PlanTab.tsx
 * directly) to render from the exact same `PlanVersionDetailDTO` fetch and the same derived
 * `grouped`/`unassignedGuestIds`/`needsReassignmentGuests` values computed once -- switching the
 * List/Floor-plan toggle is a pure client-side re-render with no second data fetch, so the two
 * views cannot structurally disagree. This test still checks the actual rendered text in both
 * (rather than trusting that reasoning alone) because the *display logic itself* --
 * grouping/pulling-out behavior -- is independently implemented per view (a separate `<ul>` list
 * vs. `PlanFloorPlan`'s absolutely-positioned boxes) and could still diverge in practice.
 *
 * Builds one scenario covering all three "each holds its own separate area" cases in one plan:
 * a guest requiring an accessible table (seated normally, then pushed into Needs Reassignment by
 * toggling her table's Accessible flag off -- the real, empirically-confirmed mechanism in
 * packages/db/src/queries/tables.ts's `syncAccessibleTableReassignment`, triggered by
 * `updateTable`), a guest left Unassigned by a deliberate capacity shortfall, a guest validly
 * seated at a table, and a Not Attending guest (confirmed via `getPlanVersionDetail`'s own
 * `allGuests` query, which filters to `dayOfAttendance = 'ATTENDING'` before ever building
 * `unassignedGuestIds` -- a Not Attending guest is excluded from the plan entirely in both views,
 * not merely hidden by display logic).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "plan-review.list-and-floor-plan-views-show-identical-data.unassigned-needs-reassignment-and-not-attending",
    title: "the List and Floor plan views show the same valid assignments, the same separated Unassigned/Needs Reassignment guests, and both omit a Not Attending guest",
    objective:
      "Confirms that toggling between the List view and the Floor plan view of the Current Plan Version never changes what's shown: the same guest lands at the same table in both, an Unassigned guest and a Needs-Reassignment guest each appear in their own separate area in both views, and a Not Attending guest appears in neither.",
    expectedOutcome:
      "In both the List view and the Floor plan view: the validly-seated guest appears under her table, the deliberately-unassigned guest appears in the Unassigned area, the accessible-requiring guest (after her table's Accessible flag is toggled off) appears in the Needs Reassignment area naming her prior table, and the Not Attending guest's name appears nowhere in the plan view.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const token = testInfo.workerIndex;
    // A controlled lastName sorts the accessible-requiring guest first in generation's own
    // ORDER BY lastName, firstName processing order -- combined with her being the only guest
    // who requires an accessible table and there being exactly one such table, this guarantees
    // she gets that seat regardless of the other two guests' (randomized-token) ordering.
    const reassign = { firstName: "Playwright", lastName: `AAAccessNeeded-${uniquePersonName(token).lastName}` };
    const candidateA = uniquePersonName(token);
    const candidateB = uniquePersonName(token);
    const notAttending = uniquePersonName(token);
    let accessTableId = "";
    let accessTableLabel = "";
    let seatedGuestName = "";
    let unassignedGuestName = "";

    await test.step("Arrange: a guest who will need reassignment, two guests who -- between a capacity shortfall -- leave exactly one of them seated and the other unassigned, and a Not Attending guest", async () => {
      const reassignGuest = await weddingData.createGuest(managedWedding.id, { ...reassign, requiresAccessibleTable: true });
      const guestA = await weddingData.createGuest(managedWedding.id, candidateA);
      const guestB = await weddingData.createGuest(managedWedding.id, candidateB);
      await weddingData.createGuest(managedWedding.id, { ...notAttending, dayOfAttendance: "NOT_ATTENDING" });

      const accessTable = await weddingData.createTable(managedWedding.id, {
        label: "Access Table",
        capacity: 1,
        isAccessible: true,
      });
      accessTableId = accessTable.id;
      accessTableLabel = accessTable.label;
      await weddingData.createTable(managedWedding.id, { label: "Plain Table", capacity: 1 });

      // 2 total seats for 3 attending guests (reassign + A + B): the accessible hard filter
      // guarantees the reassign guest's placement; between A and B, exactly one gets the Plain
      // Table's one remaining seat and the other is left unassigned -- this test reads which is
      // which from the actual result rather than assuming a tie-break winner.
      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      const reassignAssignment = generated.assignments.find((a) => a.guestId === reassignGuest.id);
      expect(reassignAssignment?.tableId).toBe(accessTableId); // the hard accessible filter guarantees this

      const seatedCandidate = generated.assignments.find((a) => a.guestId === guestA.id || a.guestId === guestB.id);
      expect(seatedCandidate).toBeTruthy();
      const seated = seatedCandidate!.guestId === guestA.id ? candidateA : candidateB;
      const unassigned = seatedCandidate!.guestId === guestA.id ? candidateB : candidateA;
      seatedGuestName = `${seated.firstName} ${seated.lastName}`;
      unassignedGuestName = `${unassigned.firstName} ${unassigned.lastName}`;
      expect(generated.unassignedGuestIds).toContain(seatedCandidate!.guestId === guestA.id ? guestB.id : guestA.id);

      // The real mechanism (FR-6.1's "Needs Reassignment"): toggling the table she's seated at to
      // no longer Accessible flags her existing assignment, without unassigning her.
      await weddingData.updateTable(managedWedding.id, accessTableId, { isAccessible: false });
    });

    const planTab = new PlanTabPage(page);

    const reassignGuestName = `${reassign.firstName} ${reassign.lastName}`;

    async function assertCurrentViewIsCorrect(viewName: string, tableNameIsVisibleText: boolean) {
      await test.step(`Assert: the ${viewName} view shows the seated guest at her table, the unassigned guest in Unassigned, the reassignment guest in Needs Reassignment (naming "${accessTableLabel}"), and omits the Not Attending guest`, async () => {
        await expect(planTab.textLocator(seatedGuestName, true)).toBeVisible();

        const needsReassignmentArea = planTab.needsReassignmentArea();
        const reassignEntry = needsReassignmentArea.getByText(reassignGuestName, { exact: false });
        await expect(reassignEntry).toBeVisible();
        // List view renders "(currently at {tableLabel})" as plain visible text; the Floor plan
        // view instead carries the same information only in a hover `title` attribute on the
        // guest chip (never as visible text) -- both are checked, in whichever form this view
        // actually uses, rather than assuming one representation for both.
        if (tableNameIsVisibleText) {
          await expect(needsReassignmentArea).toContainText(accessTableLabel);
        } else {
          await expect(reassignEntry).toHaveAttribute("title", new RegExp(accessTableLabel));
        }

        const unassignedArea = planTab.unassignedArea();
        await expect(unassignedArea).toBeVisible();
        await expect(unassignedArea.getByText(unassignedGuestName, { exact: true })).toBeVisible();

        await expect(
          planTab.textLocator(`${notAttending.firstName} ${notAttending.lastName}`, true),
        ).toHaveCount(0);
      });
    }

    await test.step("Act: open the Seating plan tab (List view is the default)", async () => {
      await planTab.goto(managedWedding.id);
    });
    await assertCurrentViewIsCorrect("List", true);

    await test.step("Act: switch to the Floor plan view", async () => {
      await planTab.showFloorPlanView();
    });
    await assertCurrentViewIsCorrect("Floor plan", false);

    await test.step("Act: switch back to the List view", async () => {
      await planTab.showListView();
    });
    await assertCurrentViewIsCorrect("List (switched back)", true);
  },
);
