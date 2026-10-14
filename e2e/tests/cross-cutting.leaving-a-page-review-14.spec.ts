/**
 * Review 14 (TS-264 follow-up, REQ-NON-FUNCTIONAL) — leaving a page with typing in it:
 * - Dashboard: with "Add a wedding" typed in, the browser's Back asks first (Stay keeps the typing,
 *   Leave goes back), and a reload asks through the browser's own question.
 * - Wedding page: Back pressed the instant something is typed still asks (the Back guard used to go
 *   in a moment after the typing, so a pasted-in value then Back left without asking).
 * - Stay after "← Back to dashboard" puts focus back on that link (Safari doesn't focus a clicked
 *   link, so focus fell to the top of the page); and Back pressed while the question is already up,
 *   then Stay, puts focus back on the control that first asked (it fell to the page).
 * - A Collaborators setting whose save is refused because it was changed elsewhere, after its tab
 *   was closed, leaves a "Couldn't save …" note (the typing used to vanish without a word).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { AccountPage } from "../pages/AccountPage.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { DashboardPage } from "../pages/DashboardPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { WeddingGuestsPage } from "../pages/WeddingGuestsPage.js";
import { patchWedding } from "../data/api.js";

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-14.dashboard-back-and-reload",
    title: "dashboard with a half-typed wedding: the browser's Back asks first and a reload asks through the browser",
    objective:
      "Confirms (review 14) that on the dashboard, with a wedding name typed in 'Add a wedding' (reached from the Account page), the browser's Back shows 'Leave and lose what you typed?' instead of leaving; Stay keeps the typing on the dashboard; Back then Leave without saving goes back to the Account page; and that a reload with typing in the form asks through the browser's own 'Leave site?' question.",
    expectedOutcome:
      "After Back: the question shows and the address is still /dashboard. After Stay: the name box still reads 'Half typed'. After Back and Leave without saving: the address is /account. With the form typed in again, a reload is asked about ('beforeunload').",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@risk:normal", "@suite:regression"],
  },
  async ({ account, page }) => {
    void account;
    const dashboard = new DashboardPage(page);
    const browserQuestions = new WeddingDetailPage(page);
    await new AccountPage(page).goto();
    await dashboard.goto();
    await dashboard.weddingNameInput().fill("Half typed");

    await test.step("Back asks first; Stay keeps the typing", async () => {
      await browserQuestions.goBackWithUnsavedInput();
      await expect(dashboard.leaveQuestion()).toBeVisible();
      await expect(page).toHaveURL(/\/dashboard$/);
      await dashboard.stayOnDashboard();
      await expect(dashboard.weddingNameInput()).toHaveValue("Half typed");
    });

    await test.step("Back, then Leave without saving, goes back to the Account page", async () => {
      await browserQuestions.goBackWithUnsavedInput();
      await expect(dashboard.leaveQuestion()).toBeVisible();
      await Promise.all([page.waitForURL(/\/account$/), dashboard.leaveWithoutSaving()]);
    });

    await test.step("A reload with the form typed in is asked about", async () => {
      await dashboard.goto();
      await dashboard.weddingNameInput().fill("Typed again");
      expect(await browserQuestions.reloadAndCatchLeaveQuestion()).toBe("beforeunload");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-14.wedding-page-back-and-focus",
    title: "wedding page: Back the instant something is typed still asks, and Stay puts focus back where the question came from",
    objective:
      "Confirms (review 14) that on the Guests tab, Back pressed straight after typing a guest's first name (no pause) shows the unsaved-changes question; that after '← Back to dashboard' and Stay focus is on that link; and that with the question already up from a tab click, Back then Stay puts focus back on that tab rather than the top of the page.",
    expectedOutcome:
      "Immediate Back: the question shows and the address is still the wedding. After Back to dashboard → Stay: the back link has focus. After clicking Seating rules (question), Back (question still up) and Stay: the Seating rules tab has focus and the first-name box still holds the typing.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }) => {
    const dashboard = new DashboardPage(page);
    const detail = new WeddingDetailPage(page);
    const guests = new WeddingGuestsPage(page);
    await dashboard.goto();
    await guests.goto(managedWedding.id);

    await test.step("Back pressed the instant a name is typed asks first", async () => {
      await guests.typeNewGuestFirstName("Instant");
      await page.goBack();
      await expect(detail.unsavedChangesPrompt()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/weddings/${managedWedding.id}$`));
      await detail.stayOnTab();
    });

    await test.step("Stay after Back to dashboard puts focus back on the link", async () => {
      await detail.backToDashboardLink().click();
      await expect(detail.unsavedChangesPrompt()).toBeVisible();
      await detail.stayOnTab();
      await expect(detail.backToDashboardLink()).toBeFocused();
    });

    await test.step("Back while the question is up, then Stay, puts focus back on the tab that asked", async () => {
      await detail.clickTab("Seating rules");
      await expect(detail.unsavedChangesPrompt()).toBeVisible();
      await page.goBack();
      await expect(detail.unsavedChangesPrompt()).toBeVisible();
      await detail.stayOnTab();
      await expect(detail.tab("Seating rules")).toBeFocused();
      expect(await guests.newGuestFirstName()).toBe("Instant");
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-page-review-14.collaborators-conflict-after-leaving",
    title: "a wedding name refused as changed elsewhere after its tab was closed leaves a Couldn't save note",
    objective:
      "Confirms (review 14) that when the Wedding name box is typed in, the name is changed elsewhere meanwhile, and the planner clicks another tab (which saves the box and closes the tab), the refused save leaves a page-level 'Couldn't save the wedding name: …' note instead of the typing vanishing without a word, and the server keeps the other change.",
    expectedOutcome:
      "After clicking Guests: a note containing \"Couldn't save the wedding name\" shows, and the server's wedding name is the one changed elsewhere.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const detail = new WeddingDetailPage(page);
    const collaborators = new CollaboratorsTabPage(page);
    await collaborators.goto(managedWedding.id);
    await collaborators.weddingNameInput().fill(`${managedWedding.name} Mine`);
    const elsewhere = `${managedWedding.name} Elsewhere`;
    expect((await patchWedding(context.request, managedWedding.id, { data: { name: elsewhere } })).ok()).toBe(true);

    await detail.clickTab("Guests");
    await expect(detail.unsavedNotes().filter({ hasText: "Couldn't save the wedding name" })).toBeVisible();
    const saved = ((await (await context.request.get(`/api/v1/weddings/${managedWedding.id}`)).json()) as { wedding: { name: string } }).wedding;
    expect(saved.name).toBe(elsewhere);
  },
);
