/**
 * TS-182 (REQ-NON-FUNCTIONAL) — screens keep your work and say the right thing.
 * - A guest's notes (and the other fields that save when you leave them) count as unsaved while
 *   half-typed: switching tabs asks first, and closing the page makes the browser ask too.
 * - Day-of: a message about a guest the search is hiding is shown at the top, with their name.
 * - A timeline reorder or a new plan that worked, but whose list then couldn't be reloaded, says
 *   "Done — but the list couldn't be refreshed" instead of "Couldn't …".
 * - A slow wedding-name save can't undo the email-notifications box ticked meanwhile.
 * - The wedding page's tabs are real tabs: a tab list, the open tab marked, arrow keys move along.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DayOfTabPage } from "../pages/DayOfTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { delayResponses, failRequests } from "../support/networkFaults.js";

const REFRESH_FAILED = "Done — but the list couldn't be refreshed; reload the page.";

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-your-work-and-say-the-right-thing.half-typed-guest-notes-are-unsaved-work",
    title: "a half-typed guest note is never lost: clicking another tab saves it, and closing the page makes the browser ask",
    objective:
      "Confirms that a guest row's notes box (which saves when you leave it) saves a half-typed note when another tab is clicked -- clicking the tab leaves the box -- so no unsaved-changes prompt is needed; and that with a note half-typed again and the box never left, closing the page brings up the browser's own leave-page question.",
    expectedOutcome:
      "Clicking the Tables tab shows no prompt and the guest's saved notes read 'Half-typed note'. Closing the page with ' — another half' typed (box not left) raises a 'beforeunload' question.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const person = uniquePersonName(testInfo.workerIndex);
    const guest = await weddingData.createGuest(w, person);
    const fullName = `${person.firstName} ${person.lastName}`;
    const wedding = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    const savedNotes = async () => (await weddingData.listGuests(w)).find((g) => g.id === guest.id)?.notes ?? null;

    // TS-182: clicking a tab first takes the cursor out of the box, which saves the note -- so there
    // is nothing unsaved by the time the tab changes. The guard matters where the box is never left.
    await test.step("Clicking another tab leaves the box, so the half-typed note saves with no prompt", async () => {
      await guests.goto(w);
      await guests.guestRow(fullName).typeNotesWithoutLeaving("Half-typed note");
      await wedding.clickTab("Tables");
      await expect.poll(savedNotes).toBe("Half-typed note");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await wedding.openTab("Guests");
    });

    await test.step("Closing the page with a half-typed note makes the browser ask", async () => {
      await guests.guestRow(fullName).typeNotesWithoutLeaving(" — another half");
      expect(await wedding.closeAndCatchLeaveQuestion()).toBe("beforeunload");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-your-work-and-say-the-right-thing.messages-say-what-really-happened",
    title: "a Day-of error about a guest the search hides shows at the top, and a reorder or new plan whose list couldn't reload says it was done",
    objective:
      "Confirms that when marking a guest's attendance fails and a search then hides that guest's row, the error is shown at the top with the guest's name; that a timeline reorder that saved but whose list reload failed says 'Done — but the list couldn't be refreshed' and the order did change; and that a new plan generated while the version list can't be reloaded says the same, with the plan saved.",
    expectedOutcome:
      "The top error reads '<guest name>: Simulated outage.' The timeline shows the 'Done — but…' message and the second entry is now first on the server. The Seating plan tab shows the 'Done — but…' message and the wedding has one plan version.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:day-of-mode", "@feature:timeline", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;

    await test.step("Day-of: an error about a guest the search hides is shown at the top, with their name", async () => {
      const a = uniquePersonName(testInfo.workerIndex);
      const b = uniquePersonName(testInfo.workerIndex);
      await weddingData.createGuest(w, a);
      await weddingData.createGuest(w, b);
      const nameA = `${a.firstName} ${a.lastName}`;
      const nameB = `${b.firstName} ${b.lastName}`;
      const dayOf = new DayOfTabPage(page);
      await dayOf.goto(w);
      const fault = await failRequests(page, "**/attendance", "POST", { status: 500, error: "Simulated outage." });
      await dayOf.attendanceButtonLocator(nameA).click();
      await expect(dayOf.errorText()).toHaveText("Simulated outage.");
      await dayOf.search(nameB);
      await expect(dayOf.guestRowLocator(nameA)).toHaveCount(0);
      await expect(dayOf.errorText()).toHaveText(`${nameA}: Simulated outage.`);
      await fault.clear();
    });

    await test.step("Timeline: a reorder that saved but couldn't reload says it was done", async () => {
      const token = uniqueToken(testInfo.workerIndex);
      const first = `Toasts ${token}`;
      const second = `Cake ${token}`;
      expect((await weddingData.createTimelineEntry(w, { time: "19:00", description: first })).status).toBe(201);
      expect((await weddingData.createTimelineEntry(w, { time: "19:00", description: second })).status).toBe(201);
      const timeline = new TimelineTabPage(page);
      await timeline.goto(w);
      const fault = await failRequests(page, /\/timeline-entries$/, "GET", { status: 500, error: "Simulated outage." });
      await timeline.moveDown(first);
      await expect(timeline.errorText()).toHaveText(REFRESH_FAILED);
      await fault.clear();
      const order = (await weddingData.getTimelineEntries(w)).map((e) => e.description);
      expect(order.indexOf(second)).toBeLessThan(order.indexOf(first));
    });

    await test.step("Seating plan: a new plan whose version list couldn't reload says it was done", async () => {
      await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
      const plan = new PlanTabPage(page);
      await plan.goto(w);
      const fault = await failRequests(page, /\/plan-versions$/, "GET", { status: 500, error: "Simulated outage." });
      await plan.generate();
      await expect(plan.message(REFRESH_FAILED)).toBeVisible();
      await fault.clear();
      const res = await context.request.get(`/api/v1/weddings/${w}/plan-versions`);
      expect(((await res.json()) as { planVersions: unknown[] }).planVersions).toHaveLength(1);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-your-work-and-say-the-right-thing.slow-name-save-keeps-the-email-box",
    title: "a wedding-name save whose answer arrives late doesn't undo the email-notifications box ticked meanwhile",
    objective:
      "Confirms that when the owner renames the wedding and the server's answer is held back until after they have changed the 'Also send email notifications' box, the box keeps its new state when the late answer lands, and the server has both the new name and the new setting.",
    expectedOutcome:
      "After the name save's answer lands, the box is still in the state the owner set; the server's wedding has the new name and that emailNotificationsEnabled value.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, context, page }, testInfo) => {
    const w = managedWedding.id;
    const collab = new CollaboratorsTabPage(page);
    await collab.goto(w);
    const startChecked = await collab.emailNotificationsCheckbox().isChecked();
    const newName = `Renamed ${uniqueToken(testInfo.workerIndex)}`;

    await test.step("Rename (its answer held back), then change the box before the answer lands", async () => {
      const slow = await delayResponses(page, new RegExp(`/api/v1/weddings/${w}$`), "PATCH", 3000);
      await collab.setAndLeave(collab.weddingNameInput(), newName);
      // The server has saved the name (with the box's old value) before the box is changed.
      await expect.poll(() => slow.answered).toBe(1);
      await collab.emailNotificationsCheckbox().click();
      await expect(collab.emailNotificationsCheckbox()).toBeChecked({ checked: !startChecked });
      // The name box is disabled until the held answer lands.
      await expect(collab.weddingNameInput()).toBeEnabled({ timeout: 10_000 });
      await slow.clear();
    });

    await test.step("The box still shows the owner's choice, and the server has both changes", async () => {
      await expect(collab.emailNotificationsCheckbox()).toBeChecked({ checked: !startChecked });
      const res = await context.request.get(`/api/v1/weddings/${w}`);
      const { wedding } = (await res.json()) as { wedding: { name: string; emailNotificationsEnabled: boolean } };
      expect(wedding).toMatchObject({ name: newName, emailNotificationsEnabled: !startChecked });
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.screens-keep-your-work-and-say-the-right-thing.wedding-tabs-are-real-tabs",
    title: "the wedding page's tabs are a real tab list: the open tab is marked, the panel is named for it, and arrow keys move along",
    objective:
      "Confirms the wedding page's tab row is exposed as a tab list named 'Wedding sections', that only the open tab is marked selected and the tab panel is named after it, and that ArrowRight and End move to and open the next and last tabs with focus following.",
    expectedOutcome:
      "Guests is selected and Tables is not; the panel's accessible name is 'Guests'. After ArrowRight, Seating rules is selected, focused and names the panel. After End, Collaborators is selected and focused.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }) => {
    const wedding = new WeddingDetailPage(page);
    await wedding.goto(managedWedding.id);

    await test.step("The tab list marks the open tab and names the panel after it", async () => {
      await expect(wedding.tabList()).toBeVisible();
      await expect(wedding.tab("Guests")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.tab("Tables")).toHaveAttribute("aria-selected", "false");
      await expect(wedding.tabPanel()).toHaveAccessibleName("Guests");
    });

    await test.step("Arrow keys and End move along the tabs", async () => {
      await wedding.pressOnTab("Guests", "ArrowRight");
      await expect(wedding.tab("Seating rules")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.tab("Seating rules")).toBeFocused();
      await expect(wedding.tabPanel()).toHaveAccessibleName("Seating rules");
      await wedding.pressOnTab("Seating rules", "End");
      await expect(wedding.tab("Collaborators")).toHaveAttribute("aria-selected", "true");
      await expect(wedding.tab("Collaborators")).toBeFocused();
    });
  },
);
