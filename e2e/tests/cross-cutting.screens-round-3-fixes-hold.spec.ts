/**
 * TS-175 (REQ-NON-FUNCTIONAL) — screen fixes from the third deep dive.
 * - Marking a guest on Day-of, then editing them on the Guests tab, saves (no false "edited elsewhere").
 * - A vendor edit that loses to someone else's change closes, and never writes over it.
 * - A version nickname being typed is never saved onto another version.
 * - "1,500" in a cost box is $1,500.00; something that isn't an amount is refused, not dropped.
 * - On a phone: the Tables floor plan scrolls (a table beyond the screen moves by the arrow key's
 *   step, it used to jump back into view) and form fields are 16px (an iPhone zooms in on smaller).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { LoginPage } from "../pages/LoginPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";

defineQualityTest(
  {
    id: "cross-cutting.screens-round-3-fixes-hold.day-of-vendor-nickname-cost-phone",
    title: "Day-of then a Guests edit saves, a losing vendor edit never overwrites, nicknames stay on their version, costs accept 1,500, and phones get a scrolling floor plan and 16px fields",
    objective:
      "Confirms that after marking a guest not attending on Day-of, renaming them on the Guests tab saves with no conflict; that a vendor edit saved after someone else changed the vendor shows the conflict, closes, and leaves their change in place; that a nickname typed for one version and then a switch to another version saves nothing onto either; that a vendor cost typed as 1,500 is stored as 150000 cents and 12abc is refused with a message; and that at 375px a table placed at x=600 moves to x=610 on one arrow press and form fields render at 16px or more.",
    expectedOutcome:
      "The guest's new first name is saved and no 'edited elsewhere' message shows. The vendor keeps the other person's name and the editor is closed. Neither version gains the typed nickname. costCents 150000; the 12abc save shows 'must be an amount in dollars'. The table's x is 610; the email field's font size is at least 16px.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:tables", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;

    await test.step("Day-of attendance, then a Guests-tab edit, saves without a conflict", async () => {
      const person = uniquePersonName(testInfo.workerIndex);
      await weddingData.createGuest(w, person);
      const fullName = `${person.firstName} ${person.lastName}`;
      const dayOf = new DayOfTabPage(page);
      await dayOf.goto(w);
      await dayOf.toggleAttendance(fullName);
      const wedding = new WeddingDetailPage(page);
      await wedding.openTab("Guests");
      const guests = new WeddingGuestsPage(page);
      await guests.guestRow(fullName).editFirstName("Renamed");
      await expect.poll(async () => (await weddingData.listGuests(w)).some((g) => g.firstName === "Renamed")).toBe(true);
      await expect(guests.message(/edited elsewhere/)).toHaveCount(0);
    });

    await test.step("A vendor edit that loses to someone else's change closes and doesn't overwrite it", async () => {
      const created = await context.request.post(api("vendors"), { data: { name: "Petal Florist", category: "FLORIST" } });
      const vendorId = ((await created.json()) as { vendor: { id: string } }).vendor.id;
      const budget = new BudgetTabPage(page);
      await budget.goto(w);
      await budget.startEdit("Petal Florist");
      // Someone else renames it meanwhile.
      const current = ((await (await context.request.get(api("vendors"))).json()) as { vendors: { id: string; revision: number }[] }).vendors.find((v) => v.id === vendorId)!;
      expect((await context.request.patch(api(`vendors/${vendorId}`), { data: { name: "Bloom Florist", expectedRevision: current.revision } })).status()).toBe(200);
      await budget.setEditCost("200");
      await budget.saveEdit();
      await expect(budget.errorText()).toContainText("was just edited elsewhere");
      await expect(budget.allEditButtons()).toHaveCount(1);
      await expect.poll(async () => budget.editCostInputCount()).toBe(0);
      const after = ((await (await context.request.get(api("vendors"))).json()) as { vendors: { id: string; name: string; costCents: number | null }[] }).vendors.find((v) => v.id === vendorId)!;
      expect(after).toMatchObject({ name: "Bloom Florist", costCents: null });
    });

    await test.step("Costs accept 1,500 and refuse what isn't an amount", async () => {
      const budget = new BudgetTabPage(page);
      await budget.goto(w);
      await budget.addVendor({ name: "Comma Caterer", category: "Catering", cost: "1,500" });
      await expect
        .poll(async () => ((await (await context.request.get(api("vendors"))).json()) as { vendors: { name: string; costCents: number | null }[] }).vendors.find((v) => v.name === "Comma Caterer")?.costCents)
        .toBe(150000);
      await budget.startEdit("Comma Caterer");
      await budget.setEditCost("12abc");
      await budget.clickSaveEdit();
      await expect(budget.errorText()).toContainText("must be an amount in dollars");
    });

    await test.step("A nickname being typed isn't saved onto another version", async () => {
      await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
      const first = await weddingData.generatePlanVersion(w);
      const second = await weddingData.generatePlanVersion(w);
      const plan = new PlanTabPage(page);
      await plan.goto(w);
      await plan.addNicknameButton().click();
      await plan.nicknameInput().fill("Typed for the newest");
      await plan.versionSelect().selectOption(first.id);
      await expect(plan.nicknameInput()).toHaveCount(0);
      for (const v of [first, second]) {
        expect((await weddingData.getPlanVersionDetail(w, v.id)).label).toBeNull();
      }
    });

    await test.step("On a phone, the floor plan scrolls and form fields are 16px", async () => {
      const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, storageState: await context.storageState() });
      try {
        const phonePage = await phone.newPage();
        const far = await weddingData.createTable(w, { label: "Far", capacity: 6 });
        expect((await context.request.patch(api(`tables/${far.id}`), { data: { positionX: 600, positionY: 40 } })).status()).toBe(200);
        const tables = new TablesTabPage(phonePage);
        await tables.goto(w);
        await tables.openTablesTab();
        await tables.openFloorPlan();
        await tables.tabToFloorPlanTable("Far");
        await tables.pressOnFocusedTable("ArrowRight");
        await expect.poll(() => tables.floorPlanTablePosition("Far")).toEqual({ x: 610, y: 40 });

        const signedOut = await browser.newContext({ viewport: { width: 375, height: 812 } });
        try {
          const login = new LoginPage(await signedOut.newPage());
          await login.goto();
          expect(await login.emailFieldFontSize()).toBeGreaterThanOrEqual(16);
        } finally {
          await signedOut.close();
        }
      } finally {
        await phone.close();
      }
    });
  },
);
