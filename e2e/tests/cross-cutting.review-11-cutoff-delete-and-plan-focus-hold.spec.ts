/**
 * TS-251 / TS-253 / TS-255 (REQ-ACCOUNT-WEDDING-MANAGEMENT, REQ-COLLABORATION-NOTIFICATIONS,
 * REQ-PLAN-REVIEW-STATUS, REQ-EXPORT-PRINT-RESTORE, REQ-NON-FUNCTIONAL) — review 11's fixes on the
 * Collaborators and Seating plan tabs.
 * - Two tabs: the RSVP cutoff's "Save anyway" (for a cutoff before today) is refused with "changed
 *   since you opened them" when the cutoff was saved in the other tab meanwhile, instead of
 *   overwriting it; after that, and after "Change it", the next change saves normally.
 * - "Delete this wedding" whose answer was lost still goes to the dashboard (the retry's 404 means
 *   it was deleted), with no "Wedding not found" message.
 * - Keyboard focus goes back to the button that opened the replace-the-approved-plan question
 *   (after Cancel or confirming) and the restore preview (after Cancel), not to the page.
 * The small rules behind the first two are unit-tested in
 * apps/web/src/lib/review-11-cutoff-flag-and-delete-retry.test.mts.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { patchWedding } from "../data/api.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { loseResponses } from "../support/networkFaults.js";

// Two of the page's 4-second checks, with headroom.
const WITHIN_SECONDS = { timeout: 10_000 };

const SETTINGS_CHANGED_ELSEWHERE =
  "This wedding's settings changed since you opened them (maybe in another tab) — showing the latest. Your change wasn't saved; make it again if it's still needed.";

/** Tab 1 types a cutoff before today (the "Save anyway?" question comes up), tab 2 saves a
 * different cutoff, and tab 1's 4-second check brings that in while the question is still up. */
async function pastCutoffWhileOtherTabSaves(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  w: string,
): Promise<{ tab1: CollaboratorsTabPage; savedCutoff: () => Promise<string | null> }> {
  // A wedding date well ahead, so tab 2's cutoff asks nothing.
  expect((await patchWedding(context.request, w, { data: { eventDate: "2030-06-01" } })).ok()).toBe(true);
  const tab1 = new CollaboratorsTabPage(page);
  const tab2 = new CollaboratorsTabPage(await context.newPage());
  await tab1.goto(w);
  await tab2.goto(w);
  const savedCutoff = async () =>
    ((await (await context.request.get(`/api/v1/weddings/${w}`)).json()) as { wedding: { rsvpCutoffDate: string | null } })
      .wedding.rsvpCutoffDate;

  await tab1.setAndLeave(tab1.rsvpCutoffInput(), "2020-01-01");
  await expect(tab1.rsvpCutoffQuestion()).toContainText("before today");
  await tab2.setAndLeave(tab2.rsvpCutoffInput(), "2029-01-01");
  await expect.poll(savedCutoff).toBe("2029-01-01");
  // A check sent after tab 2's save has answered carries the newer settings.
  for (let i = 0; i < 2; i++)
    await page.waitForResponse(
      (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/weddings/${w}`,
      WITHIN_SECONDS,
    );
  await expect(tab1.rsvpCutoffQuestion()).toBeVisible();
  return { tab1, savedCutoff };
}

defineQualityTest(
  {
    id: "cross-cutting.review-11-cutoff-delete-and-plan-focus-hold.save-anyway-respects-the-other-tab",
    title: "the RSVP cutoff's Save anyway is refused when another tab saved the cutoff meanwhile, and the next change saves",
    objective:
      "Confirms (TS-251) that when the owner has the 'Save anyway?' question up for an RSVP cutoff before today in one tab, and saves a different cutoff from a second tab, pressing 'Save anyway' in the first tab -- after its 4-second check has brought in the newer settings -- doesn't overwrite the other tab's cutoff: it is refused with 'changed since you opened them' and the box shows the newer cutoff. A fresh change afterwards saves normally. Before, 'Save anyway' skipped that check (overwriting the newer cutoff) and left the flag set, so the next real change was refused.",
    expectedOutcome:
      "Tab 1 shows the 'changed since you opened them' message, the question goes, the box reads 2029-01-01 and the server keeps 2029-01-01; then 2029-02-01 typed in tab 1 saves with no message.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@feature:rsvp", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const { tab1, savedCutoff } = await pastCutoffWhileOtherTabSaves(page, context, w);

    await test.step("'Save anyway' in tab 1 is refused, and the newer cutoff stays", async () => {
      await tab1.saveCutoffAnyway();
      await expect(tab1.message(SETTINGS_CHANGED_ELSEWHERE)).toBeVisible();
      await expect(tab1.rsvpCutoffQuestion()).toHaveCount(0);
      await expect(tab1.rsvpCutoffInput()).toHaveValue("2029-01-01");
      expect(await savedCutoff()).toBe("2029-01-01");
    });

    await test.step("A fresh change from tab 1 then saves", async () => {
      await tab1.setAndLeave(tab1.rsvpCutoffInput(), "2029-02-01");
      await expect.poll(savedCutoff).toBe("2029-02-01");
      await expect(tab1.message(SETTINGS_CHANGED_ELSEWHERE)).toHaveCount(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-11-cutoff-delete-and-plan-focus-hold.change-it-clears-the-other-tab-flag",
    title: "after Change it on the RSVP cutoff question, with the cutoff saved in another tab meanwhile, the next change saves",
    objective:
      "Confirms (TS-251) that 'Change it' on the cutoff question puts the latest saved cutoff (from the other tab) in the box and forgets that it was changed elsewhere, so the next change from this tab saves rather than being refused with 'changed since you opened them'.",
    expectedOutcome:
      "After 'Change it' the box reads 2029-01-01; 2029-03-01 typed in tab 1 then saves, with no 'changed since you opened them' message.",
    requirementIds: ["REQ-ACCOUNT-WEDDING-MANAGEMENT", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:account", "@feature:rsvp", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const { tab1, savedCutoff } = await pastCutoffWhileOtherTabSaves(page, context, w);

    await test.step("'Change it' shows the latest cutoff", async () => {
      await tab1.changeCutoff();
      await expect(tab1.rsvpCutoffQuestion()).toHaveCount(0);
      await expect(tab1.rsvpCutoffInput()).toHaveValue("2029-01-01");
    });

    await test.step("The next change saves", async () => {
      await tab1.setAndLeave(tab1.rsvpCutoffInput(), "2029-03-01");
      await expect.poll(savedCutoff).toBe("2029-03-01");
      await expect(tab1.message(SETTINGS_CHANGED_ELSEWHERE)).toHaveCount(0);
    });
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-11-cutoff-delete-and-plan-focus-hold.delete-with-a-lost-answer",
    title: "Delete this wedding whose answer was lost still goes to the dashboard (the retry's 404 means it was deleted)",
    objective:
      "Confirms (TS-253 item 1) that when the answer to the owner's 'Delete this wedding' is lost after the server deleted it, the page's retry (answered 'Wedding not found') is treated as deleted: the page goes to the dashboard rather than showing a red 'Wedding not found', and the wedding is gone.",
    expectedOutcome: "The page lands on /dashboard, the delete section shows no error, and the wedding answers 404.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page, context }) => {
    const w = managedWedding.id;
    const tab = new CollaboratorsTabPage(page);
    await tab.goto(w);
    const lost = await loseResponses(page, new RegExp(`/api/v1/weddings/${w}$`), "DELETE", 1);
    // deleteWedding waits for the dashboard -- it used to stay put with "Wedding not found".
    await tab.deleteWedding(managedWedding.name);
    expect(lost.hits).toBe(1);
    await lost.clear();
    expect((await context.request.get(`/api/v1/weddings/${w}`)).status()).toBe(404);
  },
);

defineQualityTest(
  {
    id: "cross-cutting.review-11-cutoff-delete-and-plan-focus-hold.plan-questions-give-focus-back",
    title: "keyboard focus goes back to Generate after the replace-the-approved-plan question, and to Restore after cancelling the restore preview",
    objective:
      "Confirms (TS-255 item 1) that a keyboard user who answers the 'This replaces the approved plan' question with Cancel, or with 'Replace the approved plan', ends up on the 'Generate new plan' button, and that one who cancels a restore preview ends up on its 'Restore version N...' button -- before, focus dropped to the page and the next Tab started from the top.",
    expectedOutcome:
      "'Generate new plan' is focused after Cancel and after confirming (once the run is done); 'Restore version 1...' is focused after the preview's Cancel.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS", "REQ-EXPORT-PRINT-RESTORE", "REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:non-functional", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    test.setTimeout(90_000);
    const w = managedWedding.id;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    for (let i = 0; i < 2; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const first = await weddingData.generatePlanVersion(w);
    expect((await weddingData.setPlanVersionStatus(w, first.id, "APPROVED")).status).toBe(200);
    const plan = new PlanTabPage(page);
    await plan.goto(w);
    const prompt = plan.replaceApprovedPrompt();

    await test.step("Cancel on the replace-the-approved-plan question gives focus back to Generate", async () => {
      await plan.clickGenerateToReplaceCurrent();
      await expect(prompt).toBeVisible();
      await prompt.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
      await expect(prompt).toHaveCount(0);
      await expect(plan.generateNewPlanButton()).toBeFocused();
    });

    await test.step("Confirming gives focus back to Generate once the new plan is made", async () => {
      await plan.clickGenerateToReplaceCurrent();
      await expect(prompt).toBeVisible();
      await prompt.getByRole("button", { name: "Replace the approved plan", exact: true }).press("Enter");
      await expect(prompt).toHaveCount(0);
      await expect.poll(async () => (await weddingData.listPlanVersions(w)).length).toBe(2);
      await expect(plan.generateNewPlanButton()).toBeFocused();
    });

    await test.step("Cancel on the restore preview gives focus back to Restore", async () => {
      await plan.selectVersion(/^v1\b/);
      await plan.restoreButton(1).press("Enter");
      await expect(plan.restorePreview(1)).toBeVisible();
      await plan.restoreCancelButton().press("Enter");
      await expect(plan.restorePreview(1)).toHaveCount(0);
      await expect(plan.restoreButton(1)).toBeFocused();
    });
  },
);
