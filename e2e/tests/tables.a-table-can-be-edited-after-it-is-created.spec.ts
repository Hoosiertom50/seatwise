/**
 * TS-120 (REQ-TABLE-VENUE-LAYOUT) — a table can be edited after it's created: name, seats, shape,
 * purpose, the soft "favors" criterion, and whether it's Restricted to a chosen list of guests.
 * Before this, the API allowed it but the Tables tab had no way to, so a planner had to delete
 * and re-create a table -- losing everyone seated there.
 *
 * An edit never unseats anyone. Lowering the seats below the number taken, or restricting the
 * table to a list that leaves someone out, keeps everyone where they are, flags the ones who no
 * longer belong as Needs Reassignment (the plan then reads as incomplete), and says so; undoing
 * the edit clears the flag. A stale edit is refused with a message (TS-92), and View-level
 * collaborators aren't offered Edit at all.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { uniquePersonName } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

defineQualityTest(
  {
    id: "tables.a-table-can-be-edited-after-it-is-created.fields-seats-restricted-stale-and-view-only",
    title: "a table's name, seats, shape, purpose, favors and restricted list can be edited in place -- flagging, never unseating, guests an edit leaves out -- a stale edit is refused, and View users get no Edit",
    objective:
      "Confirms the Tables tab's Edit form saves name, shape, purpose and favors (and Cancel discards), that lowering seats below the guests seated there flags the overflow as Needs Reassignment with a warning and restoring the seats clears it, that restricting the table to a list that omits a seated guest flags that guest, that nobody is ever unseated by an edit, that an edit based on a stale table is refused with a message and the other change kept, and that a View collaborator sees no Edit button.",
    expectedOutcome:
      "The row and the API show 'Sweetheart', Rectangular, 'Couple and parents', favoring Family; a cancelled rename leaves it unchanged. At 2 seats one of the three guests is flagged and a 'no longer fits' warning shows, the plan is incomplete, and all three are still assigned; at 3 seats no one is flagged and the plan is complete. Restricted to two guests, the third is flagged with an 'isn't on this table's required list' warning and requiredGuestIds holds the two. A stale save shows 'was just edited elsewhere' and the label stays as the other change set it. The View collaborator's Tables tab has no Edit button.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, context, browser }, testInfo) => {
    const tablesTab = new TablesTabPage(page);
    const w = managedWedding.id;
    const guests = [uniquePersonName(testInfo.workerIndex), uniquePersonName(testInfo.workerIndex), uniquePersonName(testInfo.workerIndex)];
    const guestIds: string[] = [];
    for (const g of guests) guestIds.push((await weddingData.createGuest(w, g)).id);
    const head = await weddingData.createTable(w, { label: "Head", capacity: 4 });
    const plan = await weddingData.generatePlanVersion(w);
    expect(plan.assignments.filter((a) => a.tableId === head.id)).toHaveLength(3);
    const currentPlan = () => weddingData.getPlanVersionDetail(w, plan.id);
    const tableNow = async () => (await weddingData.listTables(w)).find((t) => t.id === head.id)!;

    await tablesTab.goto(w);
    await tablesTab.openTablesTab();

    await test.step("Cancel discards an edit", async () => {
      await tablesTab.openTableEdit("Head");
      await tablesTab.fillTableEdit("Head", { name: "Never saved" });
      await tablesTab.cancelTableEdit("Head");
      await expect(tablesTab.editForm("Head")).toHaveCount(0);
      expect((await tableNow()).label).toBe("Head");
    });

    await test.step("Name, shape, purpose and favors are saved", async () => {
      await tablesTab.openTableEdit("Head");
      await tablesTab.fillTableEdit("Head", { name: "Sweetheart", shape: "Rectangular", purpose: "Couple and parents", favors: "Relationship tier", favorsWhich: "Family" });
      await tablesTab.saveTableEdit("Head");
      await expect(tablesTab.editTableButton("Sweetheart")).toBeVisible();
      await expect(tablesTab.textLocator("Couple and parents", false)).toBeVisible();
      expect(await tableNow()).toMatchObject({
        label: "Sweetheart",
        shape: "RECTANGULAR",
        purpose: "Couple and parents",
        purposeCriterionType: "TIER",
        purposeCriterionValue: "FAMILY",
        capacity: 4,
      });
    });

    await test.step("Fewer seats than are taken flags the overflow -- nobody is unseated -- and restoring them clears it", async () => {
      await tablesTab.openTableEdit("Sweetheart");
      await tablesTab.fillTableEdit("Sweetheart", { seats: 2 });
      await tablesTab.saveTableEdit("Sweetheart");
      await expect(tablesTab.warning(/no longer fits at this table \(it now seats 2\) — flagged as Needs Reassignment\./)).toBeVisible();

      let detail = await currentPlan();
      expect(detail.assignments.filter((a) => a.tableId === head.id)).toHaveLength(3);
      expect(detail.assignments.filter((a) => a.needsReassignment)).toHaveLength(1);
      expect(detail.isComplete).toBe(false);

      await tablesTab.openTableEdit("Sweetheart");
      await tablesTab.fillTableEdit("Sweetheart", { seats: 3 });
      await tablesTab.saveTableEdit("Sweetheart");
      await expect(tablesTab.editForm("Sweetheart")).toHaveCount(0);
      detail = await currentPlan();
      expect(detail.assignments.filter((a) => a.needsReassignment)).toHaveLength(0);
      expect(detail.isComplete).toBe(true);
    });

    await test.step("Restricting it to a list that leaves a seated guest out flags that guest", async () => {
      const [first, second, third] = guests;
      await tablesTab.openTableEdit("Sweetheart");
      await tablesTab.fillTableEdit("Sweetheart", {
        restricted: true,
        requiredGuests: [`${first.firstName} ${first.lastName}`, `${second.firstName} ${second.lastName}`],
      });
      await tablesTab.saveTableEdit("Sweetheart");
      await expect(tablesTab.warning(`${third.firstName} ${third.lastName} isn't on this table's required list any more — flagged as Needs Reassignment.`)).toBeVisible();

      const table = await tableNow();
      expect(table.isRestricted).toBe(true);
      expect([...table.requiredGuestIds].sort()).toEqual([guestIds[0], guestIds[1]].sort());
      const detail = await currentPlan();
      expect(detail.assignments.filter((a) => a.tableId === head.id)).toHaveLength(3);
      expect(detail.assignments.find((a) => a.guestId === guestIds[2])!.needsReassignment).toBe(true);
    });

    await test.step("An edit based on a stale table is refused, and the other change is kept", async () => {
      await tablesTab.openTableEdit("Sweetheart");
      await tablesTab.fillTableEdit("Sweetheart", { name: "Mine" });
      const theirs = await context.request.patch(`/api/v1/weddings/${w}/tables/${head.id}`, { data: { label: "Theirs" } });
      expect(theirs.ok()).toBe(true);
      await tablesTab.saveTableEdit("Sweetheart");
      await expect(tablesTab.message(/^"Theirs" was just edited elsewhere — showing the latest\./)).toBeVisible();
      await expect(tablesTab.editTableButton("Theirs")).toBeVisible();
      expect((await tableNow()).label).toBe("Theirs");
    });

    await test.step("A View collaborator isn't offered Edit", async () => {
      const viewer = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "viewer");
      try {
        await weddingData.addCollaborator(w, viewer.email, "VIEW");
        const viewerTab = new TablesTabPage(await viewer.context.newPage());
        await viewerTab.goto(w);
        await viewerTab.openTablesTab();
        await expect(viewerTab.textLocator("You have view-only access to this wedding's tables")).toBeVisible();
        await expect(viewerTab.textLocator(/^Theirs/).first()).toBeVisible();
        await expect(viewerTab.editTableButton("Theirs")).toHaveCount(0);
      } finally {
        await viewer.context.close();
      }
    });
  },
);
