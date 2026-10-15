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
      // PR #116 review: the answer arriving isn't the page having applied it -- wait for the saved
      // entry to show (it's applied in the same step that decides which editor closes).
      await expect(timeline.entryRowLocator(`Ceremony moved ${token}`)).toBeVisible();
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
      // PR #116 review: wait for the saved vendor to show before checking the other editor.
      await expect(budget.editButtonLocator(`Florist renamed ${token}`)).toBeVisible();
      await expect(budget.editNameInputLocator()).toHaveCount(1);
      await expect(budget.editNameInputLocator()).toHaveValue(`Baker typed ${token}`);
    } finally {
      await slowSave.clear();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.late-save-keeps-other-editor-review-17.timeline-same-entry",
    title: "a Timeline entry's late save doesn't close the same entry's editor opened again since, and that editor can't undo the save",
    objective:
      "Confirms (review 18) that when a Timeline entry is saved, its editor cancelled while the save is on its way, and the same entry's editor opened again and typed in, the first save coming back leaves the reopened editor open with its typing.",
    expectedOutcome: "After the first save's answer: one editor is open and its description box still holds what was typed after reopening. Saving that editor is refused (409) and the first save's entry stays.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const timeline = new TimelineTabPage(page);
    const token = uniqueToken(testInfo.workerIndex);
    await timeline.goto(managedWedding.id);
    await timeline.addEntry("17:00", `Ceremony ${token}`);
    await timeline.addEntry("18:00", `Dinner ${token}`);

    const slowSave = await delayRequests(page, /\/timeline-entries\/[^/]+$/, "PATCH", 2_500);
    try {
      const answered = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/timeline-entries\/[^/]+$/.test(new URL(r.url()).pathname));
      await timeline.startEdit(`Ceremony ${token}`);
      // Moved after Dinner, so the list's new order shows when the save has been applied.
      await timeline.editTimeInputLocator().fill("19:00");
      await timeline.editDescriptionInputLocator().fill(`Ceremony moved ${token}`);
      await timeline.clickSaveEdit();
      await timeline.cancelEdit();
      await timeline.startEdit(`Ceremony ${token}`);
      await timeline.editDescriptionInputLocator().fill(`Ceremony typed again ${token}`);
      await answered;
      // PR #116 review: wait for the save to be applied -- Dinner is now first (applied in the same
      // step that decides whether this editor closes).
      await expect(timeline.entryRows().first()).toContainText(`Dinner ${token}`);
      await expect(timeline.editDescriptionInputLocator()).toHaveCount(1);
      await expect(timeline.editDescriptionInputLocator()).toHaveValue(`Ceremony typed again ${token}`);

      // Review 18: that editor was filled from before the first save -- saving it is refused (409) and
      // the first save stays; it used to go through and quietly undo it.
      const second = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/timeline-entries\/[^/]+$/.test(new URL(r.url()).pathname));
      await timeline.clickSaveEdit();
      expect((await second).status()).toBe(409);
      await expect(timeline.entryRowLocator(`Ceremony moved ${token}`)).toBeVisible();
      await expect(timeline.entryRows().last()).toContainText(`Ceremony moved ${token}`);
    } finally {
      await slowSave.clear();
    }
  },
);

defineQualityTest(
  {
    id: "cross-cutting.late-save-keeps-other-editor-review-17.budget-same-vendor",
    title: "a vendor's late save doesn't close the same vendor's editor opened again since, and that editor can't undo the save",
    objective:
      "Confirms (review 18) that when a vendor is saved, its editor cancelled while the save is on its way, and the same vendor's editor opened again and typed in, the first save coming back leaves the reopened editor open with its typing.",
    expectedOutcome: "After the first save's answer: one editor is open and its name box still holds what was typed after reopening. Saving that editor is refused (409) and the first save's vendor and cost stay.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:budget", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const budget = new BudgetTabPage(page);
    const token = uniqueToken(testInfo.workerIndex);
    await budget.goto(managedWedding.id);
    await budget.addVendor({ name: `Florist ${token}` });

    const slowSave = await delayRequests(page, /\/vendors\/[^/]+$/, "PATCH", 2_500);
    try {
      const answered = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/vendors\/[^/]+$/.test(new URL(r.url()).pathname));
      await budget.startEdit(`Florist ${token}`);
      await budget.setEditName(`Florist renamed ${token}`);
      // A cost, so the "Recorded so far" total shows when the save has been applied.
      await budget.setEditCost("250");
      await budget.clickSaveEdit();
      await budget.cancelEdit();
      await budget.startEdit(`Florist ${token}`);
      await budget.setEditName(`Florist typed again ${token}`);
      await answered;
      // PR #116 review: the total is updated after the step that decides whether this editor closes.
      await expect(budget.recordedSoFarText()).toHaveText("$250.00");
      await expect(budget.editNameInputLocator()).toHaveCount(1);
      await expect(budget.editNameInputLocator()).toHaveValue(`Florist typed again ${token}`);

      // Review 18: that editor was filled from before the first save -- saving it is refused (409) and
      // the first save (its cost) stays; it used to go through and quietly undo it.
      const second = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/vendors\/[^/]+$/.test(new URL(r.url()).pathname));
      await budget.clickSaveEdit();
      expect((await second).status()).toBe(409);
      await expect(budget.editButtonLocator(`Florist renamed ${token}`)).toBeVisible();
      await expect(budget.recordedSoFarText()).toHaveText("$250.00");
    } finally {
      await slowSave.clear();
    }
  },
);


defineQualityTest(
  {
    id: "cross-cutting.late-save-keeps-other-editor-review-17.timeline-neighbour-moved",
    title: "moving the entry next to an open Timeline edit doesn't stop that edit saving",
    objective:
      "Confirms (review 19) that with two Timeline entries at the same time, an edit open on one of them still saves after the other is moved up past it -- the move changes only their order, and the edit used to be refused as changed elsewhere (losing the typing).",
    expectedOutcome: "The save is accepted (200) and the entry shows the new description.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:timeline", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, page }, testInfo) => {
    const timeline = new TimelineTabPage(page);
    const token = uniqueToken(testInfo.workerIndex);
    await timeline.goto(managedWedding.id);
    await timeline.addEntry("17:00", `Toast ${token}`);
    await timeline.addEntry("17:00", `Speech ${token}`);

    await timeline.startEdit(`Toast ${token}`);
    await timeline.editDescriptionInputLocator().fill(`Toast edited ${token}`);
    await timeline.moveUp(`Speech ${token}`);
    // Review 20: the move applied on the page (Speech now first) before saving -- the editor takes the
    // moved entry's new revision in that same step.
    await expect(timeline.entryRows().first()).toContainText(`Speech ${token}`);
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/timeline-entries\/[^/]+$/.test(new URL(r.url()).pathname));
    await timeline.clickSaveEdit();
    expect((await saved).status()).toBe(200);
    await expect(timeline.entryRowLocator(`Toast edited ${token}`)).toBeVisible();
  },
);
