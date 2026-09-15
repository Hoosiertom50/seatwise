/**
 * TS-47 (REQ-EXPORT-PRINT-RESTORE) — converts AC-068 ("Restoring a prior version is
 * non-destructive").
 *
 * Traced directly in packages/db/src/queries/plan-versions.ts's `computeRestorePlacement` /
 * `previewPlanVersionRestore` / `restorePlanVersion`: restoring a version never rewrites history --
 * it copies the source version's own assignments into a brand-new, separately-numbered version
 * (which becomes Current only because it's the newest, exactly like a fresh generation would),
 * leaving the source and every version in between completely untouched. Because guests, tables,
 * and rules can all have changed since the source was captured, every one of its assignments is
 * re-validated against *current* data before being copied (FR-0.1): a table that's shrunk below
 * what it now holds, or a new Must-Not-Sit-Together rule, drops the affected guest to Unassigned
 * with a plain-language reason (never silently kept invalid); a new Must-Sit-Together rule the
 * restored layout doesn't satisfy is a non-blocking warning instead (reshuffling the copied layout
 * to fix it would stop this from actually being a restore of what v2 looked like). The AC's own
 * "v1 through v5" framing is illustrative, not literal -- what's actually verified below is that at
 * least two versions created after the source remain byte-for-byte unchanged (bar the one
 * "isCurrent" flag every new version naturally takes over, which the AC's own wording is about
 * preserving *content*, not that flag) after restoring an *earlier* version out from under them.
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";
import { uniquePersonName } from "../data/ids.js";

defineQualityTest(
  {
    id: "export-print.restoring-a-prior-version-is-non-destructive.creates-a-new-version-and-leaves-history-intact",
    title: "restoring an earlier version copies its assignments into a brand-new, Current version -- re-validated against current data, dropping or warning on anything now invalid -- while every later version's own content stays untouched",
    objective:
      "Confirms restoring a source plan version creates a separate, newer version (never rewriting the source), that its assignments are re-validated against current guests/tables/rules (a shrunk table and a new Must-Not-Sit-Together rule each drop the affected guest with a reason; a new Must-Sit-Together rule on a still-otherwise-valid pair produces a non-blocking warning instead), that the restore-preview's own numbers match what the actual restore then does, that two versions created after the source are otherwise unchanged by the restore, that the restore is recorded in the wedding's change history, and that only an Edit-level (not View-level) user may actually commit the restore.",
    expectedOutcome:
      "The restored version is new, Current, Draft, and names the source's version number. An unaffected guest is kept exactly as seated; a guest whose table shrunk below their headcount, and one of a pair given a new Must-Not-Sit-Together rule, are both dropped to Unassigned with a reason; a pair given a new Must-Sit-Together rule stay at their (different) tables with a warning naming both. Two later versions' own assignments, status, and version numbers are identical before and after. A RESTORE entry appears in the activity feed naming the source version. A View-level collaborator can preview but is denied (403) committing the restore.",
    requirementIds: ["REQ-EXPORT-PRINT-RESTORE"],
    tags: ["@mutating", "@feature:export", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, account }, testInfo) => {
    const token = testInfo.workerIndex;

    const keepGuest = uniquePersonName(token);
    const capGuest = { ...uniquePersonName(token), headcount: 2 };
    const mnstA = uniquePersonName(token);
    const mnstB = uniquePersonName(token);
    const mtogA = uniquePersonName(token);
    const mtogB = uniquePersonName(token);

    let sourceVersionId = "";
    let sourceVersionNumber = 0;
    let keepGuestId = "", capGuestId = "", mnstAId = "", mnstBId = "", mtogAId = "", mtogBId = "";
    let keepTableId = "", capTableId = "", togetherTableId = "", apartTable1Id = "", apartTable2Id = "";
    let togetherTableLabel = "";

    await test.step("Arrange: six guests and five tables, then generate a source version and place every guest exactly as this scenario needs (never trusting generation's own placement)", async () => {
      const keep = await weddingData.createGuest(managedWedding.id, keepGuest);
      keepGuestId = keep.id;
      const cap = await weddingData.createGuest(managedWedding.id, capGuest);
      capGuestId = cap.id;
      const a1 = await weddingData.createGuest(managedWedding.id, mnstA);
      mnstAId = a1.id;
      const b1 = await weddingData.createGuest(managedWedding.id, mnstB);
      mnstBId = b1.id;
      const a2 = await weddingData.createGuest(managedWedding.id, mtogA);
      mtogAId = a2.id;
      const b2 = await weddingData.createGuest(managedWedding.id, mtogB);
      mtogBId = b2.id;

      const keepTable = await weddingData.createTable(managedWedding.id, { label: "Keep Table", capacity: 4 });
      keepTableId = keepTable.id;
      const capTable = await weddingData.createTable(managedWedding.id, { label: "Cap Table", capacity: 2 });
      capTableId = capTable.id;
      const togetherTable = await weddingData.createTable(managedWedding.id, { label: "Together Table", capacity: 4 });
      togetherTableId = togetherTable.id;
      togetherTableLabel = togetherTable.label;
      const apartTable1 = await weddingData.createTable(managedWedding.id, { label: "Apart Table 1", capacity: 2 });
      apartTable1Id = apartTable1.id;
      const apartTable2 = await weddingData.createTable(managedWedding.id, { label: "Apart Table 2", capacity: 2 });
      apartTable2Id = apartTable2.id;

      const generated = await weddingData.generatePlanVersion(managedWedding.id);
      expect(generated.isComplete).toBe(true);
      sourceVersionId = generated.id;
      sourceVersionNumber = generated.versionNumber;

      // Generation already seated every guest somewhere of its own choosing, which can transiently
      // occupy the exact table this scenario wants a *different* guest placed at next (a real
      // capacity conflict, not a bug) -- unassign everyone first so every table starts empty, then
      // place all six guests at their scenario-specific tables in any order without any
      // in-between state to conflict with.
      for (const guestId of [keepGuestId, capGuestId, mnstAId, mnstBId, mtogAId, mtogBId]) {
        const res = await weddingData.moveGuestAssignment(managedWedding.id, sourceVersionId, guestId, null);
        expect(res.status).toBe(200);
      }

      for (const [guestId, tableId] of [
        [keepGuestId, keepTableId],
        [capGuestId, capTableId], // headcount 2 into a capacity-2 table -- exactly fits today
        [mnstAId, togetherTableId],
        [mnstBId, togetherTableId], // no Must-Not rule between them yet -- both fit together today
        [mtogAId, apartTable1Id],
        [mtogBId, apartTable2Id], // seated apart -- no Must-Together rule requires otherwise today
      ] as const) {
        const res = await weddingData.moveGuestAssignment(managedWedding.id, sourceVersionId, guestId, tableId);
        expect(res.status).toBe(200);
      }
    });

    let laterVersion1Id = "";
    let laterVersion2Id = "";
    let laterVersion1Before: unknown;
    let laterVersion2Before: unknown;

    await test.step("Arrange: two more versions generated after the source, to prove restoring an earlier one leaves them alone", async () => {
      const next1 = await weddingData.generatePlanVersion(managedWedding.id);
      laterVersion1Id = next1.id;
      const next2 = await weddingData.generatePlanVersion(managedWedding.id);
      laterVersion2Id = next2.id;

      laterVersion1Before = await weddingData.getPlanVersionDetail(managedWedding.id, laterVersion1Id);
      laterVersion2Before = await weddingData.getPlanVersionDetail(managedWedding.id, laterVersion2Id);
      expect((laterVersion1Before as { isCurrent: boolean }).isCurrent).toBe(false);
      expect((laterVersion2Before as { isCurrent: boolean }).isCurrent).toBe(true);
    });

    await test.step("Arrange: change guests/tables/rules since the source was captured -- a shrunk table, a new Must-Not-Sit-Together rule, and a new Must-Sit-Together rule", async () => {
      await weddingData.updateTable(managedWedding.id, capTableId, { capacity: 1 }); // capGuest (headcount 2) no longer fits
      await weddingData.createRelationship(managedWedding.id, mnstAId, mnstBId, "MUST_NOT_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, mtogAId, mtogBId, "MUST_SIT_TOGETHER");
    });

    let expectedDroppedMnstId = "";
    let expectedKeptMnstId = "";
    await test.step("Assert: exactly the capacity-shrunk guest and exactly one of the Must-Not-Sit-Together pair are dropped, each with a reason naming why", async () => {
      const res = await weddingData.previewRestore(managedWedding.id, sourceVersionId);
      expect(res.status).toBe(200);
      const preview = res.body.preview!;
      expect(preview.sourceVersionNumber).toBe(sourceVersionNumber);

      const capDrop = preview.droppedGuests.find((d) => d.guestId === capGuestId);
      expect(capDrop, "capGuest should be dropped").toBeTruthy();
      expect(capDrop!.reason.toLowerCase()).toContain("capacity");

      const mnstDrops = preview.droppedGuests.filter((d) => d.guestId === mnstAId || d.guestId === mnstBId);
      expect(mnstDrops, "exactly one of the Must-Not-Sit-Together pair should be dropped").toHaveLength(1);
      expect(mnstDrops[0].reason.toLowerCase()).toContain("must not sit together");
      expectedDroppedMnstId = mnstDrops[0].guestId;
      expectedKeptMnstId = expectedDroppedMnstId === mnstAId ? mnstBId : mnstAId;

      expect(preview.droppedGuests).toHaveLength(2);
      expect(preview.keptCount).toBe(4); // 6 guests - 2 dropped
      expect(preview.unassignedGuestIds.sort()).toEqual([capGuestId, expectedDroppedMnstId].sort());
      expect(preview.isComplete).toBe(false);

      expect(preview.warnings).toHaveLength(1);
      expect(preview.warnings[0]).toContain(mtogA.firstName);
      expect(preview.warnings[0]).toContain(mtogB.firstName);
      expect(preview.warnings[0].toLowerCase()).toContain("required to sit together");
    });

    let restoredVersionId = "";
    await test.step("Act: commit the restore", async () => {
      const versionsBefore = await weddingData.listPlanVersions(managedWedding.id);

      const res = await weddingData.restoreVersion(managedWedding.id, sourceVersionId);
      expect(res.status).toBe(201);
      const planVersion = res.body.planVersion!;
      restoredVersionId = planVersion.id;

      expect(planVersion.restoredFromVersionNumber).toBe(sourceVersionNumber);
      expect(planVersion.status).toBe("DRAFT");
      expect(planVersion.isCurrent).toBe(true);
      expect(planVersion.isComplete).toBe(false);

      const versionsAfter = await weddingData.listPlanVersions(managedWedding.id);
      expect(versionsAfter.length).toBe(versionsBefore.length + 1);
      expect(Math.max(...versionsAfter.map((v) => v.versionNumber))).toBe(planVersion.versionNumber);

      // Warnings are ephemeral -- confirmed directly in getPlanVersionDetail's own query, which
      // always returns warnings: [] -- so they only ever exist in the response of the very action
      // that produced them (this restore's own POST response), never retrievable from a later GET.
      const restoreWarnings = res.body.warnings!;
      const mustTogetherWarning = restoreWarnings.find((w) => w.toLowerCase().includes("required to sit together"));
      expect(mustTogetherWarning).toContain(mtogA.firstName);
      expect(mustTogetherWarning).toContain(mtogB.firstName);
      expect(
        restoreWarnings.some((w) => w.toLowerCase().includes("capacity") || w.toLowerCase().includes("no longer has room")),
      ).toBe(true);
      expect(restoreWarnings).toHaveLength(3); // the Must-Together warning + one "left Unassigned" line per dropped guest
    });

    await test.step("Assert: the restored version keeps the unaffected guest, drops exactly the same two guests the preview named, and keeps the Must-Sit-Together pair apart at their original (different) tables", async () => {
      const detail = await weddingData.getPlanVersionDetail(managedWedding.id, restoredVersionId);
      expect(detail.assignments).toHaveLength(4);
      expect(detail.assignments.find((a) => a.guestId === keepGuestId)?.tableId).toBe(keepTableId);
      expect(detail.assignments.find((a) => a.guestId === mtogAId)?.tableId).toBe(apartTable1Id);
      expect(detail.assignments.find((a) => a.guestId === mtogBId)?.tableId).toBe(apartTable2Id);
      expect(detail.assignments.find((a) => a.guestId === expectedKeptMnstId)?.tableId).toBe(togetherTableId);
      expect(detail.assignments.find((a) => a.guestId === capGuestId)).toBeUndefined();
      expect(detail.assignments.find((a) => a.guestId === expectedDroppedMnstId)).toBeUndefined();
      expect(detail.unassignedGuestIds.sort()).toEqual([capGuestId, expectedDroppedMnstId].sort());
    });

    await test.step("Assert: the two later versions are otherwise untouched by the restore -- only the previously-Current one's own isCurrent flag moved to the new restored version", async () => {
      const laterVersion1After = await weddingData.getPlanVersionDetail(managedWedding.id, laterVersion1Id);
      const laterVersion2After = await weddingData.getPlanVersionDetail(managedWedding.id, laterVersion2Id);

      expect(laterVersion1After).toEqual(laterVersion1Before); // fully untouched -- was never Current
      expect(laterVersion2After).toEqual({ ...(laterVersion2Before as object), isCurrent: false });
    });

    await test.step("Assert: the source version itself is completely untouched", async () => {
      const sourceAfter = await weddingData.getPlanVersionDetail(managedWedding.id, sourceVersionId);
      expect(sourceAfter.assignments).toHaveLength(6);
      expect(sourceAfter.assignments.find((a) => a.guestId === capGuestId)?.tableId).toBe(capTableId);
      expect(sourceAfter.isCurrent).toBe(false);
    });

    await test.step("Assert: a RESTORE entry appears in the wedding's activity feed, naming the source version and this account", async () => {
      const entries = await weddingData.getActivity(managedWedding.id);
      const restoreEntry = entries.find((e) => e.planVersionId === restoredVersionId && e.action === "RESTORE");
      expect(restoreEntry).toBeTruthy();
      expect(restoreEntry!.description).toContain(`version ${sourceVersionNumber}`);
      expect(restoreEntry!.actorName).toBe(account.name);
    });

    const baseURL = getEnv().APP_URL;
    const viewContext = await playwrightRequest.newContext({ baseURL });
    try {
      await test.step("Arrange: a View-level collaborator", async () => {
        const viewAccount = await signUpFreshAccount(viewContext, token);
        await weddingData.addCollaborator(managedWedding.id, viewAccount.email, "VIEW");
      });

      await test.step("Assert: the View collaborator can preview a restore but is denied actually committing one", async () => {
        const previewRes = await viewContext.get(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${sourceVersionId}/restore-preview`,
        );
        expect(previewRes.status()).toBe(200);

        const restoreRes = await viewContext.post(
          `/api/v1/weddings/${managedWedding.id}/plan-versions/${sourceVersionId}/restore`,
        );
        expect(restoreRes.status()).toBe(403);
      });
    } finally {
      await viewContext.dispose();
    }
  },
);
