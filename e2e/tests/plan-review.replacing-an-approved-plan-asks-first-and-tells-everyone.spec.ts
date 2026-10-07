/**
 * TS-231 (REQ-PLAN-REVIEW-STATUS, REQ-COLLABORATION-NOTIFICATIONS) — the owner and Couple members
 * may replace an approved plan (Tom's decision), but it used to happen with no warning and without
 * telling anyone: one Generate click made a new Draft current, PDF exports stopped, and nobody knew.
 * - Generate on an approved plan (draft box unticked) now asks "This replaces the approved plan"
 *   first; Cancel makes nothing. Ticking the draft box replaces nothing, so it doesn't ask.
 * - The restore preview says the same when confirming would replace the approved plan.
 * - A Generate or Restore that replaces it tells every other member: "The approved seating plan was
 *   replaced by version N (Draft)." (STATUS_CHANGED).
 * - Removing a table that seats guests on an approved plan tells them too, like a move
 *   (TABLE_CHANGED); on a Draft plan it doesn't.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

interface NotificationRow {
  type: string;
  message: string;
}

async function notifications(ctx: { get: (url: string) => Promise<{ json(): Promise<unknown> }> }): Promise<NotificationRow[]> {
  const res = await ctx.get("/api/v1/notifications");
  return ((await res.json()) as { notifications: NotificationRow[] }).notifications;
}

const REPLACES_APPROVED =
  "This replaces the approved plan. The new version becomes the current plan as a Draft, PDF exports wait until it's approved again, and everyone on the wedding is told.";

defineQualityTest(
  {
    id: "plan-review.replacing-an-approved-plan-asks-first-and-tells-everyone.generate-asks-and-notifies",
    title: "Generate on an approved plan asks before replacing it, Cancel makes nothing, a comparison draft doesn't ask, and replacing it tells the other members",
    objective:
      "Confirms that the owner's Generate on an approved current plan shows 'This replaces the approved plan…' before running; that Cancel creates no version; that with 'Save as comparison draft' ticked it doesn't ask and the approved plan stays current; and that confirming makes the new Draft current and gives an Edit collaborator one STATUS_CHANGED notification naming the new version (and none to the owner who did it).",
    expectedOutcome:
      "Prompt shown with the exact text; after Cancel the version count is unchanged; the draft run adds a non-current version with no prompt; after confirming, the new version is current and Draft, and the collaborator has 'The approved seating plan was replaced by version 3 (Draft).'",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS", "REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    for (let i = 0; i < 3; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const first = await weddingData.generatePlanVersion(w);
    expect((await weddingData.setPlanVersionStatus(w, first.id, "APPROVED")).status).toBe(200);
    const versions = () => weddingData.listPlanVersions(w);

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    try {
      await weddingData.addCollaborator(w, editor.email, "EDIT");
      const plan = new PlanTabPage(page);
      await plan.goto(w);

      await test.step("Generate asks first, and Cancel makes nothing", async () => {
        await plan.clickGenerate();
        await expect(plan.replaceApprovedPrompt()).toBeVisible();
        await expect(plan.replaceApprovedPrompt()).toContainText(REPLACES_APPROVED);
        // Focus goes to the answer, so a keyboard user is right there.
        await expect(plan.replaceApprovedPrompt().getByRole("button", { name: "Replace the approved plan" })).toBeFocused();
        await plan.cancelReplaceApproved();
        await expect(plan.replaceApprovedPrompt()).toHaveCount(0);
        expect(await versions()).toHaveLength(1);
      });

      await test.step("A comparison draft replaces nothing, so it doesn't ask", async () => {
        await plan.generate(true);
        await expect(plan.replaceApprovedPrompt()).toHaveCount(0);
        await expect.poll(async () => (await versions()).length).toBe(2);
        const current = (await versions()).find((v) => v.isCurrent)!;
        expect(current.id).toBe(first.id);
        expect(current.status).toBe("APPROVED");
        expect((await notifications(editor.context.request)).filter((n) => n.type === "STATUS_CHANGED")).toHaveLength(0);
      });

      await test.step("Confirming replaces it, and the collaborator is told", async () => {
        // Unticks the draft box (left ticked by the last step) and clicks Generate -- which asks.
        await plan.generate(false);
        await expect(plan.replaceApprovedPrompt()).toBeVisible();
        expect(await versions()).toHaveLength(2);
        await plan.confirmReplaceApproved();
        await expect.poll(async () => (await versions()).find((v) => v.isCurrent)?.versionNumber).toBe(3);
        const current = (await versions()).find((v) => v.isCurrent)!;
        expect(current.status).toBe("DRAFT");
        await expect
          .poll(async () => (await notifications(editor.context.request)).filter((n) => n.type === "STATUS_CHANGED" && /replaced/.test(n.message)).map((n) => n.message))
          .toEqual(["The approved seating plan was replaced by version 3 (Draft)."]);
        // Not to the owner, who did it.
        expect((await notifications(page.request)).some((n) => n.message.startsWith("The approved seating plan was replaced"))).toBe(false);
      });
    } finally {
      await editor.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "plan-review.replacing-an-approved-plan-asks-first-and-tells-everyone.restore-says-so-and-notifies",
    title: "the restore preview says confirming replaces the approved plan, and the restore tells the other members",
    objective:
      "Confirms that when the owner previews restoring an older version while the current plan is approved, the preview says 'This replaces the approved plan…'; that confirming makes the restored version current; and that an Edit collaborator gets one STATUS_CHANGED notification naming the new version. Also confirms the preview of a restore with a Draft current plan says nothing of the kind.",
    expectedOutcome:
      "Preview shows the replace-approved line; after confirming, version 3 is current and the collaborator has 'The approved seating plan was replaced by version 3 (Draft).'; with a Draft current plan the line isn't shown.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS", "REQ-EXPORT-PRINT-RESTORE", "REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    for (let i = 0; i < 2; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const first = await weddingData.generatePlanVersion(w);
    const second = await weddingData.generatePlanVersion(w);
    const versions = () => weddingData.listPlanVersions(w);

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    try {
      await weddingData.addCollaborator(w, editor.email, "EDIT");
      const plan = new PlanTabPage(page);

      await test.step("With a Draft current plan, the preview says nothing about replacing an approval", async () => {
        await plan.goto(w);
        await plan.selectVersion(new RegExp(`^v${first.versionNumber}\\b`));
        await plan.restoreButton(first.versionNumber).click();
        await expect(plan.restorePreview(first.versionNumber)).toBeVisible();
        await expect(plan.restoreReplacesApprovedNote()).toHaveCount(0);
        await plan.cancelRestore();
      });

      expect((await weddingData.setPlanVersionStatus(w, second.id, "APPROVED")).status).toBe(200);

      await test.step("With the current plan approved, the preview says confirming replaces it", async () => {
        await plan.goto(w);
        await plan.selectVersion(new RegExp(`^v${first.versionNumber}\\b`));
        await plan.restoreButton(first.versionNumber).click();
        await expect(plan.restorePreview(first.versionNumber)).toBeVisible();
        await expect(plan.restoreReplacesApprovedNote()).toHaveText(REPLACES_APPROVED);
        // The "saved as a comparison draft" line is for people who can't replace it -- not the owner.
        await expect(plan.restoreWillBeDraftNote()).toHaveCount(0);
      });

      await test.step("Confirming replaces it, and the collaborator is told", async () => {
        await plan.confirmRestore();
        await expect.poll(async () => (await versions()).find((v) => v.isCurrent)?.versionNumber).toBe(3);
        await expect
          .poll(async () => (await notifications(editor.context.request)).filter((n) => n.type === "STATUS_CHANGED" && /replaced/.test(n.message)).map((n) => n.message))
          .toEqual(["The approved seating plan was replaced by version 3 (Draft)."]);
      });
    } finally {
      await editor.context.close();
    }
  },
);

defineQualityTest(
  {
    id: "plan-review.replacing-an-approved-plan-asks-first-and-tells-everyone.removing-a-seated-table-notifies",
    title: "removing a table that seats guests on an approved plan tells the other members, as a move does; on a Draft plan it doesn't",
    objective:
      "Confirms that with a Draft current plan, removing a table that seats a guest (confirmed) gives an Edit collaborator no TABLE_CHANGED notification, and that once the plan is approved, removing another seated table gives them one TABLE_CHANGED notification naming the table and how many guests were left unassigned.",
    expectedOutcome:
      "Draft: no TABLE_CHANGED. Approved: exactly one TABLE_CHANGED, 'Table \"Second\" was removed from the approved plan — 1 guest was left unassigned.'",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    // One seat per table, so each guest is at their own table.
    const tables = [
      await weddingData.createTable(w, { label: "First", capacity: 1 }),
      await weddingData.createTable(w, { label: "Second", capacity: 1 }),
      await weddingData.createTable(w, { label: "Third", capacity: 1 }),
    ];
    for (let i = 0; i < 3; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const plan = await weddingData.generatePlanVersion(w);
    expect(plan.isComplete).toBe(true);
    const remove = async (label: string) => {
      const table = tables.find((t) => t.label === label)!;
      const res = await context.request.delete(`/api/v1/weddings/${w}/tables/${table.id}?confirm=true&seatedCount=1`);
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { unseatedCount: number }).unseatedCount).toBe(1);
    };

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    try {
      await weddingData.addCollaborator(w, editor.email, "EDIT");
      const tableChanged = async () => (await notifications(editor.context.request)).filter((n) => n.type === "TABLE_CHANGED");

      await test.step("On a Draft plan, nobody is told", async () => {
        await remove("First");
        expect(await tableChanged()).toHaveLength(0);
      });

      await test.step("On an approved plan, the other members are told", async () => {
        // The plan is incomplete after the removal above -- seat the unseated guest somewhere first
        // isn't possible (every table is full), so a table with room is added for them.
        const spare = await weddingData.createTable(w, { label: "Spare", capacity: 2 });
        const detail = await weddingData.getPlanVersionDetail(w, plan.id);
        for (const guestId of detail.unassignedGuestIds) {
          expect((await weddingData.moveGuestAssignment(w, plan.id, guestId, spare.id)).status).toBe(200);
        }
        expect((await weddingData.setPlanVersionStatus(w, plan.id, "APPROVED")).status).toBe(200);
        await remove("Second");
        await expect
          .poll(async () => (await tableChanged()).map((n) => n.message))
          .toEqual(['Table "Second" was removed from the approved plan — 1 guest was left unassigned.']);
      });
    } finally {
      await editor.context.close();
    }
  },
);
