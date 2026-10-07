/**
 * TS-151 (REQ-NON-FUNCTIONAL) — everyday edits behave the way a planner expects, in a US time zone.
 * - A wedding's date shows as that date, not the day before.
 * - A vendor's cost can be typed one key at a time when editing.
 * - Two quick edits to one guest both save, with no false "changed since you loaded it".
 * - When a guest is refreshed from elsewhere, their text fields show the new values, and tabbing
 *   through them doesn't write the old text back.
 * - A Day-of walk-in whose seating fails is still added once, never twice.
 * - Double-clicking Reply posts one reply.
 * - A Couple member with Comment access can approve; an Edit collaborator who isn't Couple can't.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { CommentsTabPage } from "../pages/CommentsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

test.use({ timezoneId: "America/Chicago", locale: "en-US" });

defineQualityTest(
  {
    id: "cross-cutting.everyday-edits-behave-as-typed.dates-cost-quick-edits-walk-in-reply-approve",
    title: "dates show the right day, costs can be typed, quick or refreshed guest edits keep the newest values, walk-ins and replies aren't doubled, and Couple members can approve",
    objective:
      "In a US time zone, confirms that a wedding dated 2027-06-12 shows 06-12-2027 on the dashboard; that typing 1500 into a vendor's Edit cost saves $1,500.00; that changing a guest's RSVP and side back to back saves both with no conflict message; that after a guest's notes change elsewhere and the page refreshes that guest, the notes box shows the new text and tabbing through it keeps it; that a walk-in whose table is full is added exactly once with the form cleared; that double-clicking Reply posts one reply; and that a Couple member with Comment access sees and uses Approve while a non-Couple Edit collaborator sees no Approve button.",
    expectedOutcome:
      "Dashboard row shows 06-12-2027. Vendor cost reads $1,500.00. Guest is CONFIRMED and GROOM with no error. Notes box shows the new text and the server still has it after blur. One walk-in guest exists and the form is empty. The thread has exactly one reply. Couple approves (badge Approved); the Edit user has no Approve button.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:budget", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, weddingGuestsPage, page, context, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;

    await test.step("A wedding's date shows as that date in a US time zone", async () => {
      const dated = await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Dated Wedding"), { eventDate: "2027-06-12" });
      const dashboard = new DashboardPage(page);
      await dashboard.goto();
      await expect(dashboard.weddingLink(dated.name)).toContainText("06-12-2027");
    });

    await test.step("A vendor's cost can be typed one key at a time when editing", async () => {
      const budget = new BudgetTabPage(page);
      await budget.goto(w);
      await budget.addVendor({ name: "Petal Pushers", category: "Florist" });
      await budget.startEdit("Petal Pushers");
      await budget.typeEditCost("1500");
      expect(await budget.editCostValue()).toBe("1500");
      await budget.saveEdit();
      await expect(budget.vendorCostText("Petal Pushers")).toHaveText("$1,500.00");
    });

    const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const fullName = `${guest.firstName} ${guest.lastName}`;

    await test.step("Two quick edits to one guest both save, with no false conflict", async () => {
      await weddingGuestsPage.goto(w);
      await weddingGuestsPage.openGuestsTab();
      const row = weddingGuestsPage.guestRow(fullName);
      await Promise.all([row.setRsvpStatus("CONFIRMED"), row.setSide("GROOM")]);
      await page.waitForLoadState("networkidle");
      await expect(weddingGuestsPage.message(/changed since you loaded it .*— showing the latest/)).toHaveCount(0);
      const saved = ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${guest.id}`)).json()) as {
        guest: { rsvpStatus: string; side: string };
      }).guest;
      expect(saved).toMatchObject({ rsvpStatus: "CONFIRMED", side: "GROOM" });
    });

    await test.step("A guest refreshed from elsewhere shows the new notes, and tabbing through keeps them", async () => {
      const row = weddingGuestsPage.guestRow(fullName);
      // Someone else changes the notes; then this page makes an edit, gets the conflict, and is
      // refreshed with that guest's latest copy.
      const current = ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${guest.id}`)).json()) as {
        guest: { revision: number };
      }).guest;
      await context.request.patch(`/api/v1/weddings/${w}/guests/${guest.id}`, {
        data: { notes: "Needs a high chair", expectedRevision: current.revision },
      });
      await row.setRsvpStatus("DECLINED");
      await expect(weddingGuestsPage.message(/changed since you loaded it .*— showing the latest/)).toBeVisible();
      expect(await row.notes()).toBe("Needs a high chair");
      await row.editNotes("Needs a high chair");
      const after = ((await (await context.request.get(`/api/v1/weddings/${w}/guests/${guest.id}`)).json()) as {
        guest: { notes: string | null };
      }).guest;
      expect(after.notes).toBe("Needs a high chair");
    });

    await test.step("A walk-in whose table is full is added once, and the form clears", async () => {
      // The guests are seated at another table; Head Table is added afterwards, so it has room.
      await weddingData.createTable(w, { label: "Main Table", capacity: 10 });
      await weddingData.generatePlanVersion(w);
      const table = await weddingData.createTable(w, { label: "Head Table", capacity: 1 });
      expect(table.id).toBeTruthy();
      const dayOf = new DayOfTabPage(page);
      await dayOf.goto(w);
      // TS-208: a full table isn't offered for a walk-in any more, so the table filling up between
      // picking it and the seat being saved is played by the server refusing the seat.
      await page.route(/\/plan-versions\/[^/]+\/assignments$/, (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: '"Head Table" is full now.' }) })
          : route.continue(),
      );
      try {
        await dayOf.addWalkIn("Sam", "Walkin", "Head Table");
        await expect(dayOf.errorText()).toBeVisible();
      } finally {
        await page.unroute(/\/plan-versions\/[^/]+\/assignments$/);
      }
      expect(await dayOf.walkInFirstNameValue()).toBe("");
      const { guests } = (await (await context.request.get(`/api/v1/weddings/${w}/guests`)).json()) as {
        guests: { firstName: string; lastName: string }[];
      };
      expect(guests.filter((g) => g.firstName === "Sam" && g.lastName === "Walkin")).toHaveLength(1);
    });

    await test.step("Double-clicking Reply posts one reply", async () => {
      await weddingData.postComment(w, { targetType: "GUEST", guestId: guest.id, body: "Seat near the door?" });
      const comments = new CommentsTabPage(page);
      await comments.goto(w);
      expect(await comments.doubleClickReply("Seat near the door?", "Yes, table 1")).toBe(1);
      const { comments: all } = (await (await context.request.get(`/api/v1/weddings/${w}/comments`)).json()) as {
        comments: { body: string }[];
      };
      expect(all.filter((c) => c.body === "Yes, table 1")).toHaveLength(1);
    });

    await test.step("A Couple member with Comment access can approve; a non-Couple Edit collaborator can't", async () => {
      const couple = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "couple");
      const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
      try {
        await weddingData.addCollaborator(w, couple.email, "COMMENT", "COUPLE");
        await weddingData.addCollaborator(w, editor.email, "EDIT");
        // Seat everyone so the plan can be approved, then put it in review.
        await context.request.patch(`/api/v1/weddings/${w}/tables/${(await weddingData.listTables(w))[0].id}`, {
          data: { capacity: 10 },
        });
        const plan = await weddingData.generatePlanVersion(w);
        await weddingData.setPlanVersionStatus(w, plan.id, "IN_REVIEW");

        const editorPlan = new PlanTabPage(await editor.context.newPage());
        await editorPlan.goto(w);
        await expect(editorPlan.statusBadge("In review")).toBeVisible();
        await expect(editorPlan.approveControl()).toHaveCount(0);

        const couplePlan = new PlanTabPage(await couple.context.newPage());
        await couplePlan.goto(w);
        await couplePlan.approveAsReviewer();
        await expect(couplePlan.statusBadge("Approved")).toBeVisible();
      } finally {
        await couple.context.close();
        await editor.context.close();
      }
    });
  },
);
