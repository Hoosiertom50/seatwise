/**
 * TS-179 (REQ-PLAN-REVIEW-STATUS) — Tom's decision, 2026-10-06: Generate or Restore by someone who
 * can't undo an approval (anyone but the owner, or a Couple member with Comment/Edit) on an
 * approved plan saves a comparison draft, and the approved plan stays current. The Plan tab says
 * so and opens the draft.
 * - The plan's status is checked as the new version is saved (under the wedding lock), so an
 *   approval landing while a Generate is on its way is still respected.
 * - A status change checks the plan's real status under its lock: an Edit collaborator's "back to
 *   Draft" that was sent while the plan was In review is refused if the plan was approved meanwhile.
 * - Exports need the version to be approved AND current: a replaced approved version can't be
 *   exported, and the Plan tab doesn't offer it.
 *
 * The races are made exact by holding the wedding's row lock (holdWeddingLock) or the plan
 * version's row lock (holdPlanVersion) from the test.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { holdPlanVersion, holdWeddingLock } from "../support/testDatabase.js";

const DRAFT_NOTICE =
  "The plan is approved, so this was saved as a comparison draft — only the owner or a Couple member can replace an approved plan.";

defineQualityTest(
  {
    id: "plan-review.an-approved-plan-is-only-replaced-by-someone-who-can-approve.draft-race-and-export",
    title: "Generate or Restore by an Edit collaborator keeps an approved plan current, also when the approval lands mid-request; a stale un-approve is refused; only the current approved plan exports",
    objective:
      "Confirms that an Edit collaborator (not a Couple member) who generates from the Plan tab on an approved plan gets a comparison draft and the notice, with the approved version still current; that their Restore does the same; that the owner's Generate still replaces it; that an approved version that's been replaced can't be exported (409) and shows no export links, while the current one exports; that an approval landing while the collaborator's Generate waits for the wedding lock still turns it into a draft; and that the collaborator's move to Draft, sent while the plan was In review, is refused (403) when the plan is approved before it gets the plan's lock.",
    expectedOutcome:
      "Collaborator Generate: notice shown, approved version still current and Approved, new version not current. Collaborator Restore: 201, savedAsDraftBecauseApproved true, approved version still current. Owner Generate: new version current, savedAsDraftBecauseApproved false. Replaced approved version: export 409 'isn't the current plan any more', no export links; current approved version exports 200. Raced Generate: 201 with savedAsDraftBecauseApproved true. Raced status change: 403 'undo an approval', plan still Approved.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS", "REQ-EXPORT-PRINT-RESTORE"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:export", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page, browser }, testInfo) => {
    test.setTimeout(150_000);
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    for (let i = 0; i < 3; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));

    const current = async () => (await weddingData.listPlanVersions(w)).find((v) => v.isCurrent)!;
    const approve = async (planVersionId: string) =>
      expect((await weddingData.setPlanVersionStatus(w, planVersionId, "APPROVED")).status).toBe(200);

    const editor = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "editor");
    try {
      await weddingData.addCollaborator(w, editor.email, "EDIT");
      const first = await weddingData.generatePlanVersion(w);
      await approve(first.id);

      await test.step("An Edit collaborator's Generate on an approved plan is saved as a comparison draft", async () => {
        const editorPage = await editor.context.newPage();
        const plan = new PlanTabPage(editorPage);
        await plan.goto(w);
        await plan.generate();
        await expect(plan.savedAsDraftNotice()).toHaveText(DRAFT_NOTICE);
        // The draft is what's open now.
        await expect(plan.pastVersionNotice()).toBeVisible();
        const versions = await weddingData.listPlanVersions(w);
        expect(versions).toHaveLength(2);
        expect((await current()).id).toBe(first.id);
        expect((await current()).status).toBe("APPROVED");
        expect(versions.find((v) => v.id !== first.id)!.isCurrent).toBe(false);
        await editorPage.close();
      });

      await test.step("An Edit collaborator's Restore on an approved plan is saved as a comparison draft too", async () => {
        const restored = await editor.context.request.post(api(`plan-versions/${first.id}/restore`));
        expect(restored.status()).toBe(201);
        const body = (await restored.json()) as { savedAsDraftBecauseApproved: boolean; planVersion: { isCurrent: boolean } };
        expect(body.savedAsDraftBecauseApproved).toBe(true);
        expect(body.planVersion.isCurrent).toBe(false);
        expect((await current()).id).toBe(first.id);
      });

      const ownerGen = await test.step("The owner's Generate still replaces the approved plan", async () => {
        const res = await context.request.post(api("plan-versions/generate"));
        expect(res.status()).toBe(201);
        const body = (await res.json()) as { savedAsDraftBecauseApproved: boolean; planVersion: { id: string; isCurrent: boolean } };
        expect(body.savedAsDraftBecauseApproved).toBe(false);
        expect(body.planVersion.isCurrent).toBe(true);
        return body.planVersion;
      });

      await test.step("Only the current approved version exports", async () => {
        const stale = await context.request.get(api(`plan-versions/${first.id}/export/chart`));
        expect(stale.status()).toBe(409);
        expect(((await stale.json()) as { error: string }).error).toContain("isn't the current plan any more");
        const plan = new PlanTabPage(page);
        await plan.goto(w);
        await plan.selectVersion(new RegExp(`^v${first.versionNumber}\\b`));
        await expect(plan.statusBadge("Approved")).toBeVisible();
        await expect(plan.exportLinks()).toHaveCount(0);

        await approve(ownerGen.id);
        const fresh = await context.request.get(api(`plan-versions/${ownerGen.id}/export/chart`));
        expect(fresh.status()).toBe(200);
        expect(fresh.headers()["content-type"]).toBe("application/pdf");
      });

      await test.step("An approval landing while the collaborator's Generate waits is still respected", async () => {
        expect((await weddingData.setPlanVersionStatus(w, ownerGen.id, "DRAFT")).status).toBe(200);
        const lock = await holdWeddingLock(w);
        let generating;
        try {
          generating = editor.context.request.post(api("plan-versions/generate"));
          await lock.waitForWaiters(1);
          await approve(ownerGen.id);
        } finally {
          await lock.release();
        }
        const res = await generating;
        expect(res.status()).toBe(201);
        expect(((await res.json()) as { savedAsDraftBecauseApproved: boolean }).savedAsDraftBecauseApproved).toBe(true);
        expect((await current()).id).toBe(ownerGen.id);
        expect((await current()).status).toBe("APPROVED");
      });

      await test.step("A move to Draft sent while the plan was In review is refused if it was approved meanwhile", async () => {
        expect((await weddingData.setPlanVersionStatus(w, ownerGen.id, "IN_REVIEW")).status).toBe(200);
        const held = await holdPlanVersion(ownerGen.id);
        let moving;
        try {
          moving = editor.context.request.post(api(`plan-versions/${ownerGen.id}/status`), { data: { status: "DRAFT" } });
          await held.waitForWaiters(1);
          await held.approveAndRelease();
        } finally {
          await held.release();
        }
        const res = await moving;
        expect(res.status()).toBe(403);
        expect(((await res.json()) as { error: string }).error).toContain("undo an approval");
        expect((await weddingData.getPlanVersionDetail(w, ownerGen.id)).status).toBe("APPROVED");
      });
    } finally {
      await editor.context.close();
    }
  },
);
