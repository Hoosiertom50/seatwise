/**
 * TS-180 (REQ-BUDGET-VENDOR-TRACKING, REQ-COLLABORATION-NOTIFICATIONS) — a View collaborator's
 * Budget tab loads vendors without their contract notes (those are private to Edit and the owner).
 * When the owner raised them to Edit while the tab was open, the tab kept that list, so the first
 * vendor edit they saved sent the blank notes back and wiped the real ones. The tab now reloads the
 * vendors when access changes, and a Save sends only the fields that were changed.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { CollaboratorsTabPage } from "../pages/CollaboratorsTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";
import { uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";

// FR-1.6's five seconds, plus headroom for the 4s access poll landing just after the change.
const WITHIN_FIVE_SECONDS = { timeout: 9_000 };
const NOTES = "Deposit due June 1; final payment on the day";

defineQualityTest(
  {
    id: "budget.promoted-collaborator-keeps-vendor-contract-notes.view-to-edit-then-save",
    title: "a collaborator raised from View to Edit with the Budget tab open sees the contract notes and can edit a vendor without wiping them",
    objective:
      "Confirms that a View collaborator's open Budget tab shows no contract notes; that after the owner raises them to Edit the same open tab shows the vendor's contract notes; and that changing only the vendor's cost and saving sends just the cost (no contract notes) and leaves the notes on record unchanged.",
    expectedOutcome:
      "Before: no notes line on the vendor's row. After the access notice 'changed to Edit', the row's notes read the planted text. The Save request carries costCents and expectedRevision but no contractNotes key; afterwards the vendor's costCents is 150000 and its contractNotes are still the planted text.",
    requirementIds: ["REQ-BUDGET-VENDOR-TRACKING", "REQ-COLLABORATION-NOTIFICATIONS"],
    tags: ["@mutating", "@feature:budget", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page, browser, context }, testInfo) => {
    const w = managedWedding.id;
    const vendorName = `Blooms ${uniqueToken(testInfo.workerIndex)}`;
    const created = await context.request.post(`/api/v1/weddings/${w}/vendors`, {
      data: { name: vendorName, category: "FLORIST", costCents: 100_000, contractNotes: NOTES },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const vendorId = ((await created.json()) as { vendor: { id: string } }).vendor.id;
    const helper = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "helper");

    try {
      await weddingData.addCollaborator(w, helper.email, "VIEW");
      const helperPage = await helper.context.newPage();
      const helperBudget = new BudgetTabPage(helperPage);
      const helperView = new WeddingDetailPage(helperPage);

      await test.step("At View, the open Budget tab shows no contract notes", async () => {
        await helperBudget.goto(w);
        await expect(helperBudget.viewOnlyNotice()).toBeVisible();
        await expect(helperBudget.vendorNotesText(vendorName)).toHaveCount(0);
      });

      await test.step("Raised to Edit, the same open tab shows the notes", async () => {
        const collaboratorsTab = new CollaboratorsTabPage(page);
        await collaboratorsTab.goto(w);
        await collaboratorsTab.setAccessLevel(helper.name, "Edit");
        await expect(helperView.accessChangedNotice("Edit")).toBeVisible(WITHIN_FIVE_SECONDS);
        await expect(helperBudget.vendorNotesText(vendorName)).toHaveText(NOTES);
      });

      await test.step("Changing only the cost sends only the cost, and the notes stay", async () => {
        await helperBudget.startEdit(vendorName);
        await helperBudget.setEditCost("1500");
        const sent = await helperBudget.saveEditReturningSentFields();
        expect(sent).toHaveProperty("costCents", 150_000);
        expect(sent).toHaveProperty("expectedRevision");
        expect(sent).not.toHaveProperty("contractNotes");

        const res = await context.request.get(`/api/v1/weddings/${w}/vendors`);
        const vendor = ((await res.json()) as { vendors: { id: string; costCents: number; contractNotes: string | null }[] }).vendors.find(
          (v) => v.id === vendorId,
        )!;
        expect(vendor.costCents).toBe(150_000);
        expect(vendor.contractNotes).toBe(NOTES);
      });
    } finally {
      await helper.context.close();
    }
  },
);
