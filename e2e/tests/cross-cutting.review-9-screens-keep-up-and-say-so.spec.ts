/**
 * TS-235 / TS-228 (REQ-TABLE-VENUE-LAYOUT, REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-ACCESS-CONTROL,
 * REQ-BUDGET-VENDOR-TRACKING, REQ-COLLABORATION-NOTIFICATIONS) — review 9's screen fixes.
 * - The Tables tab's "Assigned" and "X/Y seated" follow the current plan and the guest list while
 *   the tab is open, and a removed table's guests stop counting at once.
 * - A collaborator's open page shows the side labels the owner just renamed.
 * - The access-changed notice appears in a live region; the "no longer available" page is an
 *   alert and puts focus on "Go now".
 * - Raised from View to Edit, a vendor's Edit button waits for the list with contract notes.
 * - "Leave this wedding" whose answer was lost (the retry is answered 404) still goes to the dashboard.
 * - A comments check that comes back while a draft is being written doesn't redraw the list.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueToken } from "../data/ids.js";
import { TablesTabPage } from "../pages/TablesTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { CommentsTabPage } from "../pages/CommentsTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { delayRequests, delayResponses, loseResponses } from "../support/networkFaults.js";

// Two of the page's 4-second checks, with headroom.
const WITHIN_SECONDS = { timeout: 10_000 };

defineQualityTest(
  {
    id: "cross-cutting.review-9-screens-keep-up-and-say-so.tables-counts-follow-the-plan",
    title: "the open Tables tab's Assigned and X/Y seated follow attendance and moves made elsewhere, and drop at once when a table with guests is removed",
    objective:
      "Confirms (TS-235 item 1) that with the Tables tab open, marking a seated guest not attending elsewhere lowers 'Assigned' within seconds, a guest moved to a table elsewhere raises that table's 'X/Y seated' within seconds (the tab fetches the current plan again every 4 seconds), and removing a table with guests seated ('Remove anyway') takes its guests out of 'Assigned' straight away -- before, both figures were worked out once, when the tab opened.",
    expectedOutcome:
      "Assigned goes 2 → 1 after the decline; Alpha reads '2/4 seated (2 remaining)' after the move; Assigned reads 0 once Alpha is removed, without a reload.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const ann = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const bo = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const alpha = await weddingData.createTable(w, { label: "Alpha", capacity: 4 });
    const bravo = await weddingData.createTable(w, { label: "Bravo", capacity: 4 });
    const plan = await weddingData.generatePlanVersion(w);
    expect((await weddingData.moveGuestAssignment(w, plan.id, ann.id, alpha.id)).status).toBe(200);
    expect((await weddingData.moveGuestAssignment(w, plan.id, bo.id, bravo.id)).status).toBe(200);

    const tables = new TablesTabPage(page);
    await tables.goto(w);
    await tables.openTablesTab();
    await expect(tables.seatedText("Alpha")).toHaveText("1/4 seated (3 remaining)");
    expect(await tables.assignedCount()).toBe(2);

    await test.step("A guest marked not attending elsewhere stops counting within seconds", async () => {
      expect((await weddingData.setAttendance(w, bo.id, "NOT_ATTENDING")).status).toBe(200);
      await expect.poll(() => tables.assignedCount(), WITHIN_SECONDS).toBe(1);
      await expect(tables.seatedText("Bravo")).toHaveText("0/4 seated (4 remaining)");
    });

    await test.step("A guest seated at Alpha elsewhere shows in Alpha's count within seconds", async () => {
      expect((await weddingData.setAttendance(w, bo.id, "ATTENDING")).status).toBe(200);
      expect((await weddingData.moveGuestAssignment(w, plan.id, bo.id, alpha.id)).status).toBe(200);
      await expect(tables.seatedText("Alpha")).toHaveText("2/4 seated (2 remaining)", WITHIN_SECONDS);
      await expect.poll(() => tables.assignedCount(), WITHIN_SECONDS).toBe(2);
    });

    await test.step("Removing Alpha with its guests takes them out of Assigned at once", async () => {
      await tables.removeTable("Alpha");
      await tables.confirmTableRemoval();
      await expect(tables.tableRow("Alpha")).toHaveCount(0);
      await expect.poll(() => tables.assignedCount(), { timeout: 2_000 }).toBe(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-9-screens-keep-up-and-say-so.collaborator-sees-renamed-sides",
    title: "a collaborator's open page shows the side names the owner just changed, without a reload",
    objective:
      "Confirms (TS-235 item 2) that an Edit collaborator with the Guests tab open sees the owner's new side names ('Sam' / 'Alex') in a guest's Side list within seconds -- before, the page took a new copy of the wedding only when the person's access changed, so it kept 'Bride' / 'Groom' until reloaded.",
    expectedOutcome: "The guest row's Side list reads Bride, Groom, Both, then Sam, Alex, Both within 10 seconds, with no reload.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    const w = managedWedding.id;
    const person = uniquePersonName(testInfo.workerIndex);
    await weddingData.createGuest(w, person);
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "sides");
    try {
      await weddingData.addCollaborator(w, helper.email, "EDIT");
      const theirGuests = new WeddingGuestsPage(await helper.context.newPage());
      await theirGuests.goto(w);
      const name = `${person.firstName} ${person.lastName}`;
      await expect.poll(() => theirGuests.rowSideChoices(name)).toEqual(["Bride", "Groom", "Both"]);

      await weddingData.updateWedding(w, { sideLabel1: "Sam", sideLabel2: "Alex" });
      await expect.poll(() => theirGuests.rowSideChoices(name), WITHIN_SECONDS).toEqual(["Sam", "Alex", "Both"]);
    } finally {
      await helper.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-9-screens-keep-up-and-say-so.access-notices-are-announced",
    title: "the access-changed notice appears in a live region, and the no-longer-available page is an alert with focus on Go now",
    objective:
      "Confirms (TS-235 item 3) that the region the 'Your access … was changed' notice appears in (role=status) is on the page before the change, so screen readers announce the notice; and that when access is removed the page that replaces the wedding is announced as an alert and moves focus to 'Go now'.",
    expectedOutcome:
      "The status region is present and empty at first, then holds 'Your access to this wedding was changed to Edit.'. After removal, an alert holds 'This wedding is no longer available…' and the 'Go now' link has focus.",
    requirementIds: ["REQ-ACCESS-CONTROL", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser, context }, testInfo) => {
    const w = managedWedding.id;
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "notice");
    try {
      const collaborator = await weddingData.addCollaborator(w, helper.email, "VIEW");
      const theirPage = await helper.context.newPage();
      const theirView = new WeddingDetailPage(theirPage);
      const theirGuests = new WeddingGuestsPage(theirPage);
      await theirGuests.goto(w);
      await expect(theirView.yourAccessBadge()).toHaveText("Your access: View");

      await test.step("The live region is there before the change, and the notice appears in it", async () => {
        await expect(theirView.accessNoticeRegion()).toHaveAttribute("role", "status");
        await expect(theirView.accessNoticeRegion()).toHaveText("");
        const res = await context.request.patch(`/api/v1/weddings/${w}/collaborators/${collaborator.id}`, {
          data: { permissionLevel: "EDIT" },
        });
        expect(res.status(), await res.text()).toBe(200);
        await expect(theirView.accessNoticeRegion()).toContainText("Your access to this wedding was changed to Edit.", WITHIN_SECONDS);
      });

      await test.step("Removed: the message is an alert and focus is on Go now", async () => {
        const res = await context.request.delete(`/api/v1/weddings/${w}/collaborators/${collaborator.id}`);
        expect(res.status(), await res.text()).toBe(200);
        await expect(theirView.accessRemovedAlert()).toBeVisible(WITHIN_SECONDS);
        await expect(theirView.goNowLink()).toBeFocused();
      });
    } finally {
      await helper.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-9-screens-keep-up-and-say-so.vendor-edit-waits-for-the-notes",
    title: "raised from View to Edit with the Budget tab open, a vendor's Edit button stays off until the list with contract notes has loaded",
    objective:
      "Confirms (TS-235 item 4) that when a View collaborator with the Budget tab open is raised to Edit, and the vendor list's reload (which brings the contract notes) is slow, the vendor's Edit button is there but can't be pressed until the reload lands -- before, an edit opened from the View copy (no notes) could save empty notes over the real ones. Once it lands the button works and the notes show.",
    expectedOutcome:
      "After the 'changed to Edit' notice the vendor's Edit button is disabled while the reload is held; then it becomes enabled and the notes line reads the planted notes.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING", "REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:budget", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, browser, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const vendorName = `Blooms ${uniqueToken(testInfo.workerIndex)}`;
    const notes = "Deposit due June 1";
    const created = await context.request.post(`/api/v1/weddings/${w}/vendors`, {
      data: { name: vendorName, category: "FLORIST", contractNotes: notes },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "budget");
    try {
      const collaborator = await weddingData.addCollaborator(w, helper.email, "VIEW");
      const theirPage = await helper.context.newPage();
      const theirBudget = new BudgetTabPage(theirPage);
      const theirView = new WeddingDetailPage(theirPage);
      await theirBudget.goto(w);
      await expect(theirBudget.viewOnlyNotice()).toBeVisible();
      // From here on, the vendor list's reload takes 5 seconds.
      const slow = await delayRequests(theirPage, new RegExp(`/api/v1/weddings/${w}/vendors$`), "GET", 5_000);

      const res = await context.request.patch(`/api/v1/weddings/${w}/collaborators/${collaborator.id}`, {
        data: { permissionLevel: "EDIT" },
      });
      expect(res.status(), await res.text()).toBe(200);
      await expect(theirView.accessChangedNotice("Edit")).toBeVisible(WITHIN_SECONDS);

      await test.step("While the reload is on its way, Edit can't be pressed", async () => {
        await expect(theirBudget.vendorEditButton(vendorName)).toBeDisabled();
      });
      await test.step("Once it lands, Edit works and the notes show", async () => {
        await expect(theirBudget.vendorEditButton(vendorName)).toBeEnabled(WITHIN_SECONDS);
        await expect(theirBudget.vendorNotesText(vendorName)).toHaveText(notes);
        expect(slow.hits).toBeGreaterThan(0);
      });
      await slow.clear();
    } finally {
      await helper.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-9-screens-keep-up-and-say-so.leave-with-a-lost-answer",
    title: "Leave this wedding whose answer was lost still goes to the dashboard (the retry's 404 means they already left)",
    objective:
      "Confirms (TS-235 item 5) that when the answer to 'Leave this wedding' is lost after the server removed the collaborator, the page's retry (answered 'Wedding not found') is treated as left: the page goes to the dashboard rather than showing 'Wedding not found', and the collaborator is no longer on the wedding.",
    expectedOutcome: "The page lands on /dashboard, no 'Wedding not found' message is shown, and the collaborator list no longer has the person.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCESS-CONTROL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, browser }, testInfo) => {
    const w = managedWedding.id;
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "leaver");
    try {
      await weddingData.addCollaborator(w, helper.email, "EDIT");
      const theirPage = await helper.context.newPage();
      const theirCollaborators = new CollaboratorsTabPage(theirPage);
      await theirCollaborators.goto(w);
      const lost = await loseResponses(theirPage, new RegExp(`/api/v1/weddings/${w}/collaborators/[^/]+$`), "DELETE", 1);
      // leaveWedding waits for the dashboard -- it used to stay put with "Wedding not found".
      await theirCollaborators.leaveWedding();
      expect(lost.hits).toBe(1);
      await lost.clear();
      const left = (await weddingData.listCollaborators(w)).filter((c) => c.userEmail === helper.email);
      expect(left).toHaveLength(0);
    } finally {
      await helper.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-9-screens-keep-up-and-say-so.comments-check-waits-for-a-draft",
    title: "a comments check that set off before a draft was started doesn't redraw the list once the draft is there",
    objective:
      "Confirms (TS-228 item 4) that when the Comments tab's 4-second check has already been sent (and its answer is slow) and the person then starts writing a comment, the answer that arrives doesn't redraw the list -- a comment posted elsewhere stays out of view until the draft is cleared. Before, only 'busy' was checked when the answer arrived, so the list above the draft changed once.",
    expectedOutcome:
      "After the slow check's answer reaches the page with a draft in the box, the comment posted elsewhere isn't shown; once the draft is cleared it appears within 10 seconds.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:collaboration", "@risk:low", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }) => {
    const w = managedWedding.id;
    const table = await weddingData.createTable(w, { label: "Head Table", capacity: 8 });
    const comments = new CommentsTabPage(page);
    await comments.goto(w);
    await expect(comments.commentsHeading(0)).toBeVisible();

    const commentsPath = `/api/v1/weddings/${w}/comments`;
    const isCommentsGet = (r: { method(): string; url(): string }) => r.method() === "GET" && new URL(r.url()).pathname === commentsPath;
    // Every comments check's answer now reaches the page 3 seconds after the server gave it.
    const slow = await delayResponses(page, new RegExp(`${commentsPath}$`), "GET", 3_000);
    expect((await weddingData.postComment(w, { targetType: "TABLE", tableId: table.id, body: "Posted while the check was out" })).status).toBe(201);

    await test.step("The check sets off, then a draft is started before its answer arrives", async () => {
      await page.waitForRequest(isCommentsGet, WITHIN_SECONDS);
      await comments.typeDraft("Half-written thought");
      await page.waitForResponse((r) => isCommentsGet(r.request()), WITHIN_SECONDS);
      // The page's next 4-second access check -- time enough for that answer to have been drawn.
      await page.waitForRequest((r) => r.method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`, WITHIN_SECONDS);
      await expect(comments.threadByBody("Posted while the check was out")).toHaveCount(0);
    });

    await test.step("Clearing the draft lets the list catch up", async () => {
      await slow.clear();
      await comments.typeDraft("");
      await expect(comments.threadByBody("Posted while the check was out").first()).toBeVisible(WITHIN_SECONDS);
    });
  },
);
