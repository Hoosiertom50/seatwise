/**
 * TS-118 (REQ-DAY-OF-EMERGENCY-MODE) — the parts of Day-of mode the 2026-09-30 coverage audit found
 * untested: what it shows before any plan exists, the table-occupancy strip, guest search, and the
 * swaps it refuses.
 *
 * The UI only lists attending, seated guests in the swap pickers and drops the first pick from the
 * second list, so a self-swap or a swap with a not-attending guest can only arrive by API -- those
 * two are checked there; the same-table refusal is reachable (and checked) through the UI.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";

defineQualityTest(
  {
    id: "day-of-mode.search-occupancy-no-plan-and-swap-refusals.before-plan-strip-search-and-refused-swaps",
    title: "Day-of mode says when there's no plan yet, shows each table's seated count, filters guests by search, and refuses same-table, self and not-attending swaps",
    objective:
      "Confirms that before a plan exists Day-of mode shows the no-plan message, an empty occupancy count and no Swap panel; that once guests are seated the occupancy strip shows each table's seated/capacity count; that search narrows the list by part of a name, case-insensitively, and says so when nothing matches; that swapping two guests at the same table is refused in the UI with a message naming them; and that a self-swap or a swap with a not-attending guest is refused by the API with nobody moved.",
    expectedOutcome:
      "No plan: the message shows, 'Alpha' reads 0/2 seated, and there is no Swap panel. Seated: 'Alpha' reads 2/2 seated and 'Beta' 1/4. Searching the first guest's last name in lower case shows only that guest; 'zzzz-nobody' shows 'No guests match'; clearing shows all three. The same-table swap shows '<A> and <B> are already seated at the same table.'. The API answers 'Can't swap a guest with themselves.' and '…not currently attending.' and every assignment is unchanged.",
    requirementIds: ["REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:day-of-mode", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const dayOf = new DayOfTabPage(page);
    const [a, b, c] = [uniquePersonName(testInfo.workerIndex), uniquePersonName(testInfo.workerIndex), uniquePersonName(testInfo.workerIndex)];
    const full = (n: { firstName: string; lastName: string }) => `${n.firstName} ${n.lastName}`;
    const guestA = await weddingData.createGuest(w, a);
    const guestB = await weddingData.createGuest(w, b);
    const guestC = await weddingData.createGuest(w, c);
    const alpha = await weddingData.createTable(w, { label: "Alpha", capacity: 2 });
    const beta = await weddingData.createTable(w, { label: "Beta", capacity: 4 });

    await test.step("Before any plan: the no-plan message, an empty count, and no Swap panel", async () => {
      await dayOf.goto(w);
      await expect(dayOf.noPlanMessage()).toBeVisible();
      await expect(dayOf.occupancyCard("Alpha")).toContainText("0/2 seated");
      await expect(dayOf.swapPanel()).toHaveCount(0);
    });

    const plan = await weddingData.generatePlanVersion(w);
    // TS-244: Generate's order for same-size guests now follows their ids, not names, so where it
    // put them varies -- unseat everyone first, then seat each where this test needs them (a move
    // into a full table is refused, and the helper doesn't fail on that by itself).
    for (const g of [guestA, guestB, guestC]) expect((await weddingData.moveGuestAssignment(w, plan.id, g.id, null)).status).toBe(200);
    expect((await weddingData.moveGuestAssignment(w, plan.id, guestA.id, alpha.id)).status).toBe(200);
    expect((await weddingData.moveGuestAssignment(w, plan.id, guestB.id, alpha.id)).status).toBe(200);
    expect((await weddingData.moveGuestAssignment(w, plan.id, guestC.id, beta.id)).status).toBe(200);

    await test.step("With guests seated: each table's seated/capacity count", async () => {
      await dayOf.goto(w);
      await expect(dayOf.noPlanMessage()).toHaveCount(0);
      await expect(dayOf.occupancyCard("Alpha")).toContainText("2/2 seated");
      await expect(dayOf.occupancyCard("Beta")).toContainText("1/4 seated");
    });

    await test.step("Search narrows the list by part of a name, ignoring case, and says when nothing matches", async () => {
      await dayOf.search(a.lastName.toLowerCase());
      await expect(dayOf.guestRowLocator(full(a))).toBeVisible();
      await expect(dayOf.visibleGuestRows()).toHaveCount(1);

      await dayOf.search("zzzz-nobody");
      await expect(dayOf.noSearchMatchMessage()).toBeVisible();
      await expect(dayOf.visibleGuestRows()).toHaveCount(0);

      await dayOf.search("");
      await expect(dayOf.visibleGuestRows()).toHaveCount(3);
    });

    await test.step("Swapping two guests at the same table is refused, naming them", async () => {
      await dayOf.swapPanel().waitFor();
      await dayOf.swap(`${full(a)} (Alpha)`, `${full(b)} (Alpha)`);
      await expect(dayOf.errorText()).toContainText("are already seated at the same table.");
      await expect(dayOf.errorText()).toContainText(full(a));
    });

    await test.step("A self-swap and a swap with a not-attending guest are refused, and nobody moves", async () => {
      const self = await weddingData.swapGuestAssignments(w, plan.id, guestA.id, guestA.id);
      expect(self.status).toBeGreaterThanOrEqual(400);
      expect(self.body.error).toBe("Can't swap a guest with themselves.");

      await dayOf.toggleAttendance(full(c));
      const notAttending = await weddingData.swapGuestAssignments(w, plan.id, guestA.id, guestC.id);
      expect(notAttending.status).toBeGreaterThanOrEqual(400);
      expect(notAttending.body.error).toMatch(/not currently attending\.$/);

      const detail = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(detail.assignments.find((x) => x.guestId === guestA.id)?.tableId).toBe(alpha.id);
      expect(detail.assignments.find((x) => x.guestId === guestB.id)?.tableId).toBe(alpha.id);
    });
  },
);
