/**
 * TS-159 (REQ-NON-FUNCTIONAL) — switching tabs on the wedding page used to silently throw away
 * whatever was half-typed in the tab being left. Now leaving a tab with unsaved input asks first:
 * "Stay on this tab" keeps everything as it was, "Leave without saving" switches. A tab with
 * nothing typed switches straight away, and so does one whose form was just saved.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { WeddingDetailPage } from "../pages/WeddingDetailPage.js";

defineQualityTest(
  {
    id: "cross-cutting.leaving-a-tab-with-unsaved-input-asks-first.stay-keeps-leave-discards",
    title: "leaving a tab with unsaved input asks first; Stay keeps the input, Leave discards it, and tabs with nothing unsaved switch straight away",
    objective:
      "Confirms that with nothing typed, switching from Budget to Guests happens with no prompt; that after typing a vendor name, clicking Guests shows the unsaved-changes prompt and Stay keeps Budget open with the name still typed; that Leave without saving opens Guests and the Budget form is empty on return; and that after a vendor is added (form saved and cleared) switching needs no prompt.",
    expectedOutcome:
      "No prompt on the first switch. The prompt appears after typing; Stay leaves the vendor-name box reading 'Half-typed Florist'. Leave opens Guests; back on Budget the box is empty. After adding a vendor, switching to Guests shows no prompt.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }) => {
    const w = managedWedding.id;
    const wedding = new WeddingDetailPage(page);
    const budget = new BudgetTabPage(page);

    await test.step("With nothing typed, switching tabs happens straight away", async () => {
      await budget.goto(w);
      await wedding.clickTab("Guests");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await wedding.openTab("Budget");
    });

    await test.step("With something typed, leaving asks first, and Stay keeps it", async () => {
      await budget.typeVendorName("Half-typed Florist");
      await wedding.clickTab("Guests");
      await expect(wedding.unsavedChangesPrompt()).toBeVisible();
      await wedding.stayOnTab();
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
      await expect(budget.vendorNameInputLocator()).toHaveValue("Half-typed Florist");
    });

    await test.step("Leave without saving switches, and the half-typed input is gone", async () => {
      await wedding.clickTab("Guests");
      await wedding.leaveTabWithoutSaving();
      await expect(budget.vendorNameInputLocator()).toHaveCount(0);
      await wedding.openTab("Budget");
      await expect(budget.vendorNameInputLocator()).toHaveValue("");
    });

    await test.step("After saving, switching needs no prompt", async () => {
      await budget.addVendor({ name: "Saved Florist", category: "Florist" });
      await wedding.clickTab("Guests");
      await expect(wedding.unsavedChangesPrompt()).toHaveCount(0);
    });
  },
);
