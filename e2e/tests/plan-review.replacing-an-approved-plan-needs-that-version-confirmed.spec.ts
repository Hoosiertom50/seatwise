/**
 * TS-237 #2 (REQ-PLAN-REVIEW-STATUS) — Generate and Restore used to rely on the page's own copy of
 * the version list to decide whether to ask "This replaces the approved plan". That copy isn't
 * refreshed while an older version is open, so a plan approved elsewhere could be replaced without
 * the question. Now the page sends the approved version it confirmed replacing, and the server
 * checks it under the wedding lock: if the current plan is approved and that isn't the version
 * confirmed, nothing is saved (409, "The plan was approved a moment ago — confirm again to replace
 * it.") and the Plan tab asks again.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";

const APPROVED_MEANWHILE = "The plan was approved a moment ago — confirm again to replace it.";
const REPLACES_APPROVED = "This replaces the approved plan.";

defineQualityTest(
  {
    id: "plan-review.replacing-an-approved-plan-needs-that-version-confirmed.generate",
    title: "Generate never replaces an approved plan the person didn't confirm: approved meanwhile, it saves nothing and asks again",
    objective:
      "Confirms that a Generate request that doesn't name the approved current version (none, or another version) is refused 409 with the approved version's id and saves nothing, and naming it replaces the plan; and that on the Plan tab, with an older version open (so the page hasn't seen the approval), Generate is refused, the replace question appears with 'The plan was approved a moment ago — confirm again to replace it.', nothing is saved, and confirming replaces the approved plan.",
    expectedOutcome:
      "API: 409 with code APPROVED_PLAN_NOT_CONFIRMED and approvedVersionId for no and for a wrong confirmation, version count unchanged; 201 with the right one. Page: prompt with both lines, count unchanged and the approved plan still current; after confirming, a new Draft version is current.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const generateUrl = `/api/v1/weddings/${w}/plan-versions/generate`;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    for (let i = 0; i < 3; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const versions = () => weddingData.listPlanVersions(w);
    const current = async () => (await versions()).find((v) => v.isCurrent)!;

    await test.step("Arrange: an approved current plan", async () => {
      await weddingData.generatePlanVersion(w);
      const approved = await weddingData.generatePlanVersion(w);
      expect((await weddingData.setPlanVersionStatus(w, approved.id, "APPROVED")).status).toBe(200);
    });

    await test.step("API: without the approved version named, nothing is saved", async () => {
      const approvedId = (await current()).id;
      const older = (await versions()).find((v) => !v.isCurrent)!;
      for (const data of [{}, { replacesApprovedVersionId: null }, { replacesApprovedVersionId: older.id }]) {
        const res = await context.request.post(generateUrl, { data });
        expect(res.status(), JSON.stringify(data)).toBe(409);
        expect(await res.json()).toEqual({ error: APPROVED_MEANWHILE, code: "APPROVED_PLAN_NOT_CONFIRMED", approvedVersionId: approvedId });
      }
      expect(await versions()).toHaveLength(2);
      expect((await current()).id).toBe(approvedId);
      expect((await current()).status).toBe("APPROVED");
    });

    await test.step("API: naming it replaces the approved plan", async () => {
      const approvedId = (await current()).id;
      const res = await context.request.post(generateUrl, { data: { replacesApprovedVersionId: approvedId } });
      expect(res.status()).toBe(201);
      expect((await current()).id).not.toBe(approvedId);
      expect((await current()).status).toBe("DRAFT");
    });

    await test.step("Page: approved while an older version is open -- Generate asks again and saves nothing", async () => {
      const plan = new PlanTabPage(page);
      await plan.goto(w);
      const all = await versions();
      const latest = all.find((v) => v.isCurrent)!;
      const older = all.find((v) => !v.isCurrent)!;
      // An older version open: the page doesn't refresh the current plan's status meanwhile.
      await plan.selectVersion(new RegExp(`^v${older.versionNumber}\\b`));
      await expect(plan.pastVersionNotice()).toBeVisible();
      expect((await weddingData.setPlanVersionStatus(w, latest.id, "APPROVED")).status).toBe(200);

      await plan.clickGenerateToReplaceCurrent();
      // The page didn't know -- the server refused, and the question appears with the reason.
      await expect(plan.replaceApprovedPrompt()).toBeVisible();
      await expect(plan.replaceApprovedPrompt()).toContainText(APPROVED_MEANWHILE);
      await expect(plan.replaceApprovedPrompt()).toContainText(REPLACES_APPROVED);
      await expect(plan.replaceApprovedPrompt().getByRole("button", { name: "Replace the approved plan" })).toBeFocused();
      expect(await versions()).toHaveLength(all.length);
      expect((await current()).id).toBe(latest.id);
      expect((await current()).status).toBe("APPROVED");

      await plan.confirmReplaceApproved();
      await expect.poll(async () => (await versions()).length).toBe(all.length + 1);
      const replaced = await current();
      expect(replaced.id).not.toBe(latest.id);
      expect(replaced.status).toBe("DRAFT");
    });
  },
);

defineQualityTest(
  {
    id: "plan-review.replacing-an-approved-plan-needs-that-version-confirmed.restore",
    title: "Restore never replaces a plan approved after its preview: it saves nothing, says so, and replaces it once confirmed again",
    objective:
      "Confirms that a restore request that doesn't name the approved current version is refused 409 and saves nothing; and that on the Plan tab, when the current plan is approved after the restore preview was shown, 'Confirm restore' is refused with 'The plan was approved a moment ago — confirm again to replace it.', the preview now says it replaces the approved plan, nothing is saved, and confirming again restores it as the new current plan.",
    expectedOutcome:
      "API: 409 APPROVED_PLAN_NOT_CONFIRMED with no body. Page: the approved-meanwhile line and the replace-approved line shown, version count unchanged; after confirming again, a new current Draft version.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS", "REQ-EXPORT-PRINT-RESTORE"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, page }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    for (let i = 0; i < 2; i++) await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const first = await weddingData.generatePlanVersion(w);
    const second = await weddingData.generatePlanVersion(w);
    const versions = () => weddingData.listPlanVersions(w);
    const current = async () => (await versions()).find((v) => v.isCurrent)!;
    const plan = new PlanTabPage(page);

    await test.step("Page: the preview is shown while the current plan is still a Draft", async () => {
      await plan.goto(w);
      await plan.selectVersion(new RegExp(`^v${first.versionNumber}\\b`));
      await plan.restoreButton(first.versionNumber).click();
      await expect(plan.restorePreview(first.versionNumber)).toBeVisible();
      await expect(plan.restoreReplacesApprovedNote()).toHaveCount(0);
    });

    await test.step("Meanwhile the current plan is approved; the API refuses an unconfirmed restore", async () => {
      expect((await weddingData.setPlanVersionStatus(w, second.id, "APPROVED")).status).toBe(200);
      const res = await context.request.post(`/api/v1/weddings/${w}/plan-versions/${first.id}/restore`);
      expect(res.status()).toBe(409);
      expect(await res.json()).toEqual({ error: APPROVED_MEANWHILE, code: "APPROVED_PLAN_NOT_CONFIRMED", approvedVersionId: second.id });
      expect(await versions()).toHaveLength(2);
    });

    await test.step("Page: Confirm restore is refused, says why, and the preview now says it replaces the approved plan", async () => {
      await plan.confirmRestore();
      await expect(plan.restoreApprovedMeanwhileNote()).toHaveText(APPROVED_MEANWHILE);
      await expect(plan.restoreReplacesApprovedNote()).toContainText(REPLACES_APPROVED);
      expect(await versions()).toHaveLength(2);
      expect((await current()).id).toBe(second.id);
      expect((await current()).status).toBe("APPROVED");
    });

    await test.step("Page: confirming again restores it as the new current plan", async () => {
      await plan.confirmRestore();
      await expect.poll(async () => (await versions()).length).toBe(3);
      const restored = await current();
      expect(restored.id).not.toBe(second.id);
      expect(restored.status).toBe("DRAFT");
    });
  },
);
