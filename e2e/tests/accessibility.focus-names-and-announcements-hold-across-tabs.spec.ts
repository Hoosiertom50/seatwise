/**
 * TS-212 (REQ-NON-FUNCTIONAL) — keyboard and screen-reader gaps closed:
 * - After Edit → Save on Budget and Timeline, focus is on that row's Edit button (it used to drop to
 *   the page, so the next Tab started from the top) and Tab goes on to the row's next control.
 * - After a delete, focus stays in the list; after posting a reply, focus is on that thread's Reply.
 * - Repeated row buttons say which row they're for (guest Lock / RSVP link / New link, table
 *   Accessible / Single-side / Lock, Day-of Mark not attending, comment Resolve / Reply).
 * - Escape on "You have unsaved changes" means Stay; the bell's "Back to dashboard" closes the bell
 *   list so it doesn't cover that question; a table's Edit pressed again with changes asks first.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { CommentsTabPage } from "../pages/CommentsTabPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { NotificationsBell } from "../components/NotificationsBell.js";

defineQualityTest(
  {
    id: "accessibility.focus-names-and-announcements-hold-across-tabs.focus-stays-in-place-after-edits-deletes-and-replies",
    title: "after Edit → Save (Budget, Timeline), a delete, or posting a reply, focus stays where the planner was instead of dropping to the top",
    objective:
      "Confirms (TS-212) that saving a vendor's edit and a timeline entry's edit each leave focus on that row's Edit button and that Tab then reaches the row's Remove button; that cancelling a vendor edit does the same; that removing one of two guests leaves focus inside the guest list; and that posting a reply leaves focus on that thread's Reply button.",
    expectedOutcome:
      "Focused element ids: vendor-<id>-edit then vendor-<id>-remove after Save; vendor-<id>-edit after Cancel; timeline-<id>-edit then timeline-<id>-remove; after the delete, an element inside a guest-list row; after the reply, reply-open-<comment id>.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:budget", "@feature:timeline", "@feature:guests", "@feature:collaboration", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const wedding = new WeddingDetailPage(page);

    await test.step("Budget: Edit → Save puts focus on Edit, and Tab goes on to Remove", async () => {
      const budget = new BudgetTabPage(page);
      await budget.goto(w);
      await budget.addVendor({ name: "Focus Florist", category: "Florist" });
      await budget.startEdit("Focus Florist");
      // The form opens with focus in its first box, which has a visible label.
      await expect(budget.editFieldByVisibleLabel("Vendor name")).toBeFocused();
      await budget.setEditCost("250");
      await budget.saveEdit();
      await expect(wedding.focusedElement()).toHaveAttribute("id", /^vendor-.+-edit$/);
      await page.keyboard.press("Tab");
      await expect(wedding.focusedElement()).toHaveAttribute("id", /^vendor-.+-remove$/);
      await budget.startEdit("Focus Florist");
      await budget.cancelEdit();
      await expect(wedding.focusedElement()).toHaveAttribute("id", /^vendor-.+-edit$/);
    });

    await test.step("Timeline: Edit → Save puts focus on Edit, and Tab goes on to Remove", async () => {
      await weddingData.createTimelineEntry(w, { time: "17:30", description: "Focus cocktails" });
      const timeline = new TimelineTabPage(page);
      await timeline.goto(w);
      await timeline.startEdit("Focus cocktails");
      await timeline.saveEdit("17:45", "Focus cocktails later");
      await expect(wedding.focusedElement()).toHaveAttribute("id", /^timeline-.+-edit$/);
      await page.keyboard.press("Tab");
      await expect(wedding.focusedElement()).toHaveAttribute("id", /^timeline-.+-remove$/);
    });

    await test.step("Guests: after removing a guest, focus stays in the list", async () => {
      const first = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const guests = new WeddingGuestsPage(page);
      await guests.goto(w);
      await guests.guestRow(`${first.firstName} ${first.lastName}`).remove();
      await expect(guests.guestRow(`${first.firstName} ${first.lastName}`).locator()).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const active = document.activeElement;
            return !!active && active !== document.body && !!active.closest("li");
          }),
        )
        .toBe(true);
    });

    await test.step("Comments: after posting a reply, focus is on that thread's Reply", async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const posted = await weddingData.postComment(w, { targetType: "GUEST", guestId: guest.id, body: "Focus thread" });
      expect(posted.status).toBe(201);
      const comments = new CommentsTabPage(page);
      await comments.goto(w);
      await comments.reply("Focus thread", "On it");
      await expect(wedding.focusedElement()).toHaveAttribute("id", `reply-open-${posted.body.comment!.id}`);
    });
  },
);

defineQualityTest(
  {
    id: "accessibility.focus-names-and-announcements-hold-across-tabs.row-buttons-name-their-row",
    title: "repeated row buttons and checkboxes say which guest, table or comment they're for",
    objective:
      "Confirms (TS-212) that a guest row's Lock, RSVP link and New link buttons, a table row's Accessible and Single-side checkboxes and Lock button, Day-of's Mark not attending button, and a comment's Resolve and Reply buttons each carry the row's name in their accessible name.",
    expectedOutcome:
      "Buttons named 'Lock <guest>', 'RSVP link for <guest>', 'New link for <guest>'; checkboxes 'Accessible: Table 1' and 'Single-side: Table 1' and button 'Lock Table 1'; 'Mark not attending: <guest>'; 'Resolve <author>'s comment on <guest>' and 'Reply to <author>'s comment on <guest>'.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:tables", "@feature:day-of-mode", "@feature:collaboration", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const fullName = `${guest.firstName} ${guest.lastName}`;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    expect((await weddingData.postComment(w, { targetType: "GUEST", guestId: guest.id, body: "Named thread" })).status).toBe(201);

    await test.step("Guests", async () => {
      const guests = new WeddingGuestsPage(page);
      await guests.goto(w);
      const row = guests.guestRow(fullName).locator();
      await expect(row.getByRole("button", { name: `Lock ${fullName}`, exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: `RSVP link for ${fullName}`, exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: `New link for ${fullName}`, exact: true })).toBeVisible();
    });

    await test.step("Tables", async () => {
      const tables = new TablesTabPage(page);
      await tables.goto(w);
      await tables.openTablesTab();
      await expect(tables.accessibleCheckbox("Table 1")).toBeVisible();
      await expect(tables.singleSideCheckbox("Table 1")).toBeVisible();
      await expect(tables.tableRow("Table 1").getByRole("button", { name: "Lock Table 1", exact: true })).toBeVisible();
    });

    await test.step("Day-of", async () => {
      const dayOf = new DayOfTabPage(page);
      await dayOf.goto(w);
      await expect(dayOf.attendanceButtonLocator(fullName)).toHaveAccessibleName(`Mark not attending: ${fullName}`);
    });

    await test.step("Comments", async () => {
      const comments = new CommentsTabPage(page);
      await comments.goto(w);
      const thread = comments.threadByBody("Named thread").first();
      await expect(thread.getByRole("button", { name: new RegExp(`^Resolve .+'s comment on (Guest: )?${fullName}$`) })).toBeVisible();
      await expect(thread.getByRole("button", { name: new RegExp(`^Reply to .+'s comment on (Guest: )?${fullName}$`) })).toBeVisible();
    });
  },
);

defineQualityTest(
  {
    id: "accessibility.focus-names-and-announcements-hold-across-tabs.unsaved-question-escape-bell-and-table-edit",
    title: "Escape on the unsaved-changes question means Stay, the bell's Back to dashboard gets out of the question's way, and a changed table edit isn't thrown away by pressing Edit again",
    objective:
      "Confirms (TS-212) that with half-typed text in the add-guest form, clicking Tables and pressing Escape closes the question and keeps Guests open with the text; that opening the notifications bell and choosing its Back to dashboard closes the bell list and shows the question, and Stay puts focus on the bell; and that pressing a table's Edit again after changing its seats keeps the form open and says to save or cancel first.",
    expectedOutcome:
      "After Escape: no question, Guests still selected, the first-name box still says 'Halfway'. After the bell's Back to dashboard: the question shows, the bell list is gone, the address is unchanged; after Stay the bell has focus. After Edit again: the edit form is still open and the tab says 'Save or cancel the open edit first.'",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@feature:tables", "@accessibility", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }) => {
    const w = managedWedding.id;
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);

    await test.step("A table's Edit pressed again with changes keeps the form and asks to save or cancel", async () => {
      await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
      const tables = new TablesTabPage(page);
      await tables.goto(w);
      await tables.openTablesTab();
      await tables.openTableEdit("Table 1");
      await tables.fillTableEdit("Table 1", { seats: 10 });
      await tables.editTableButton("Table 1").click();
      await expect(tables.editForm("Table 1")).toBeVisible();
      await expect(tables.errorText()).toContainText("Save or cancel the open edit first.");
      // Put it back, so nothing is left unsaved for the next steps.
      await tables.cancelTableEdit("Table 1");
    });

    await test.step("Escape on the question is Stay", async () => {
      await guests.goto(w);
      await guests.typeNewGuestFirstName("Halfway");
      await wedding.clickTab("Tables");
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await expect(wedding.tab("Guests")).toHaveAttribute("aria-selected", "true");
      expect(await guests.newGuestFirstName()).toBe("Halfway");
    });

    await test.step("The bell's Back to dashboard closes the bell list and asks; Stay returns to the bell", async () => {
      const bell = new NotificationsBell(page);
      await bell.toggle();
      await expect(bell.panel()).toBeVisible();
      await bell.panel().getByRole("link", { name: "Back to dashboard", exact: true }).click();
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await expect(bell.panel()).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/weddings/${w}$`));
      await wedding.stayOnTab();
      await expect(bell.bell()).toBeFocused();
    });
  },
);
