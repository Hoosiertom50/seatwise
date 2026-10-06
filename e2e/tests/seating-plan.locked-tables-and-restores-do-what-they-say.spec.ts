/**
 * TS-177 (REQ-AUTOMATED-SEAT-ASSIGNMENT, REQ-EXPORT-PRINT-RESTORE) — two seating-plan promises that
 * have to match what really happens:
 * - Locking a table keeps the people already at it when a new plan is generated, and seats nobody
 *   new there (Tom's decision: "Locked: new plans keep the people already here and seat nobody new
 *   here.").
 * - A restore preview only calls the result complete if it will be: a must-sit-together pair the
 *   restored version keeps at different tables will be flagged Needs Reassignment, so the preview
 *   says they'll need fixing rather than "kept exactly as seated (complete)".
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

defineQualityTest(
  {
    id: "seating-plan.locked-tables-and-restores-do-what-they-say.locked-table-keeps-its-guests",
    title: "generating a new plan keeps everyone already at a locked table there and seats nobody new at it",
    objective:
      "Confirms that after two guests are seated at a table and the table is locked, generating again with a new guest and a new open table keeps both original guests at the locked table (with no 'locked to' fallback warning) and seats the new guest at the open table, even though the locked table has room.",
    expectedOutcome:
      "Both original guests' assignments are the locked table in the new version; the new guest's is the open table; no warning mentions 'locked to'; the new version is complete.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:tables", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData }, testInfo) => {
    const w = managedWedding.id;
    const a = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const b = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const kept = await weddingData.createTable(w, { label: "Kept", capacity: 8 });

    await test.step("Arrange: both guests seated at the only table, which is then locked", async () => {
      const first = await weddingData.generatePlanVersion(w);
      expect(first.assignments.filter((x) => x.tableId === kept.id).map((x) => x.guestId).sort()).toEqual([a.id, b.id].sort());
      await weddingData.updateTable(w, kept.id, { isLocked: true });
    });

    await test.step("Act + Assert: a new plan keeps them there and puts the newcomer at the open table", async () => {
      const c = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const open = await weddingData.createTable(w, { label: "Open", capacity: 8 });
      const next = await weddingData.generatePlanVersion(w);
      const tableOf = (id: string) => next.assignments.find((x) => x.guestId === id)?.tableId;
      expect(tableOf(a.id)).toBe(kept.id);
      expect(tableOf(b.id)).toBe(kept.id);
      expect(tableOf(c.id)).toBe(open.id);
      expect(next.warnings.join("\n")).not.toContain("locked to");
      expect(next.isComplete).toBe(true);
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.locked-tables-and-restores-do-what-they-say.restore-preview-is-honest",
    title: "a restore preview doesn't call the result complete when a must-sit-together pair will be kept at different tables",
    objective:
      "Confirms that restoring a version made before a must-sit-together rule existed -- where that pair sat at different tables -- previews as incomplete with both guests counted as needing fixing, that the Seating plan tab's preview says they're kept at their tables and will need fixing (not 'kept exactly as seated' or 'complete'), and that the restored version is indeed incomplete.",
    expectedOutcome:
      "Preview: keptCount 2, needsFixingCount 2, isComplete false, one warning naming both guests. The tab's preview text reads 'Restoring version 1 will create a new version (incomplete): 2 guest(s) kept at their tables (2 will need fixing: see below), 0 left unassigned.' The restored version's isComplete is false.",
    requirementIds: ["REQ-EXPORT-PRINT-RESTORE"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:export", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const a = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const b = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "One", capacity: 1 });
    await weddingData.createTable(w, { label: "Two", capacity: 1 });

    let v1Id = "";
    await test.step("Arrange: v1 seats the two apart; then they must sit together, and v2 is generated", async () => {
      const v1 = await weddingData.generatePlanVersion(w);
      v1Id = v1.id;
      const tableOf = (id: string) => v1.assignments.find((x) => x.guestId === id)?.tableId;
      expect(tableOf(a.id)).toBeDefined();
      expect(tableOf(a.id)).not.toBe(tableOf(b.id));
      await weddingData.createRelationship(w, a.id, b.id, "MUST_SIT_TOGETHER");
      await weddingData.generatePlanVersion(w);
    });

    await test.step("The preview counts both as needing fixing and doesn't call it complete", async () => {
      const res = await weddingData.previewRestore(w, v1Id);
      expect(res.status).toBe(200);
      const preview = res.body.preview!;
      expect(preview.keptCount).toBe(2);
      expect(preview.needsFixingCount).toBe(2);
      expect(preview.isComplete).toBe(false);
      expect(preview.warnings).toHaveLength(1);
      expect(preview.warnings[0]).toContain(a.lastName);
      expect(preview.warnings[0]).toContain(b.lastName);
    });

    await test.step("The Seating plan tab says they'll need fixing", async () => {
      const plan = new PlanTabPage(page);
      await plan.goto(w);
      await plan.selectVersion(/^v1\b/);
      await plan.restoreButton(1).click();
      await expect(plan.restorePreview(1)).toHaveText(
        "Restoring version 1 will create a new version (incomplete): 2 guest(s) kept at their tables (2 will need fixing: see below), 0 left unassigned.",
      );
    });

    await test.step("The restored version is incomplete, as previewed", async () => {
      const res = await weddingData.restoreVersion(w, v1Id);
      expect(res.status).toBe(201);
      expect(res.body.planVersion!.isComplete).toBe(false);
    });
  },
);
