/**
 * Review 17 (REQ-NON-FUNCTIONAL) — a Timeline entry's or a vendor's save that comes back late, after
 * its editor was cancelled and another entry's editor opened, closed that other editor: what had been
 * typed there was lost without a word, and focus jumped to the first entry's Edit button. Now a late
 * save closes only its own editor.
 */

import { expect, defineQualityTest } from "../fixtures/index.js";
import { BudgetTabPage } from "../pages/BudgetTabPage.js";
import { TimelineTabPage } from "../pages/TimelineTabPage.js";
import { uniqueToken } from "../data/ids.js";
import { delayRequests } from "../support/networkFaults.js";

defineQualityTest(
  {
    id: "cross-cutting.late-save-keeps-other-editor-review-17.timeline",
    title: "a Timeline entry's late save doesn't close another entry's editor or lose what's typed in it",
    objective:
      "Confirms (review 17) that when a Timeline entry is saved, its editor cancelled while the save is on its way, and another entry's editor opened and typed in, the first save coming back leaves the second editor open with its typing.",
    expectedOutcome: "After the first save's answer: one editor is open and its description box still holds what was typed.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const timeline = new TimelineTabPage(page);
    const token = uniqueToken(testInfo.workerIndex);
    await timeline.goto(managedWedding.id);
    await timeline.addEntry("17:00", `Ceremony ${token}`);
    await timeline.addEntry("19:00", `Dinner ${token}`);

    const slowSave = await delayRequests(page, /\/timeline-entries\/[^/]+$/, "PATCH", 2_500);
    try {
      const answered = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/timeline-entries\/[^/]+$/.test(new URL(r.url()).pathname));
      await timeline.startEdit(`Ceremony ${token}`);
      await timeline.editDescriptionInputLocator().fill(`Ceremony moved ${token}`);
      await timeline.clickSaveEdit();
      await timeline.cancelEdit();
      await timeline.startEdit(`Dinner ${token}`);
      await timeline.editDescriptionInputLocator().fill(`Dinner typed ${token}`);
      await answered;
      await expect(timeline.editDescriptionInputLocator()).toHaveCount(1);
      await expect(timeline.editDescriptionInputLocator()).toHaveValue(`Dinner typed ${token}`);
    } finally {
      await slowSave.clear();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.late-save-keeps-other-editor-review-17.budget",
    title: "a vendor's late save doesn't close another vendor's editor or lose what's typed in it",
    objective:
      "Confirms (review 17) that when a vendor is saved, its editor cancelled while the save is on its way, and another vendor's editor opened and typed in, the first save coming back leaves the second editor open with its typing.",
    expectedOutcome: "After the first save's answer: one editor is open and its name box still holds what was typed.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const budget = new BudgetTabPage(page);
    const token = uniqueToken(testInfo.workerIndex);
    await budget.goto(managedWedding.id);
    await budget.addVendor({ name: `Florist ${token}` });
    await budget.addVendor({ name: `Baker ${token}` });

    const slowSave = await delayRequests(page, /\/vendors\/[^/]+$/, "PATCH", 2_500);
    try {
      const answered = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/vendors\/[^/]+$/.test(new URL(r.url()).pathname));
      await budget.startEdit(`Florist ${token}`);
      await budget.setEditName(`Florist renamed ${token}`);
      await budget.clickSaveEdit();
      await budget.cancelEdit();
      await budget.startEdit(`Baker ${token}`);
      await budget.setEditName(`Baker typed ${token}`);
      await answered;
      await expect(budget.editNameInputLocator()).toHaveCount(1);
      await expect(budget.editNameInputLocator()).toHaveValue(`Baker typed ${token}`);
    } finally {
      await slowSave.clear();
    }
  },
);
