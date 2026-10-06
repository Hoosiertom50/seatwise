/**
 * TS-197 (REQ-AUTOMATED-SEAT-ASSIGNMENT, REQ-PLAN-REVIEW-STATUS, REQ-GUEST-LIST-MANAGEMENT,
 * REQ-MANUAL-ADJUSTMENT) — the Seating plan says and counts what really happened.
 * - After Generate, a guest who couldn't be seated is listed with the reason, under "Couldn't seat
 *   everyone:" (the reasons used to be lost when the tab reloaded the new version).
 * - An older version's "seated" count leaves out guests who have since declined.
 * - An import that adds an attending guest moves the current plan on a revision, so a copy from
 *   before it is refused.
 * - A comparison draft asked for with no current plan is made current, and the tab says so.
 * - A Couple member with Comment access asking to move a plan between Draft and In review is told
 *   they don't have permission (not that the plan "isn't approved any more").
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { PlanTabPage } from "../pages/PlanTabPage.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";
import { rewriteRequestJson } from "../support/networkFaults.js";

const STALE = /^This plan changed since you loaded it/;

defineQualityTest(
  {
    id: "seating-plan.says-and-counts-what-really-happened.unseated-guest-reason-shows-after-generate",
    title: "after Generate, a guest who couldn't be seated is listed with the reason under \"Couldn't seat everyone:\"",
    objective:
      "Confirms (TS-197) that when Generate can't seat everyone (two guests, one seat), the Seating plan tab shows, after the new version has loaded, a box headed \"Couldn't seat everyone:\" naming the unseated guest and the reason -- the reasons came back in the Generate answer but were dropped when the tab reloaded the version.",
    expectedOutcome:
      "The box shows \"Couldn't seat everyone:\", the unseated guest's name and 'no table has enough remaining capacity'; the version badge reads 'Version 1 — incomplete'.",
    requirementIds: ["REQ-AUTOMATED-SEAT-ASSIGNMENT"],
    tags: ["@mutating", "@feature:seating-plan", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    const names = new Map<string, string>();
    for (let i = 0; i < 2; i++) {
      const person = uniquePersonName(testInfo.workerIndex);
      names.set((await weddingData.createGuest(w, person)).id, `${person.firstName} ${person.lastName}`);
    }
    await weddingData.createTable(w, { label: "Only table", capacity: 1 });

    const plan = new PlanTabPage(page);
    await test.step("Generate from the Seating plan tab", async () => {
      await plan.goto(w);
      await plan.generate();
      await expect(plan.openVersionBadge(1)).toHaveText("Version 1 — incomplete");
    });

    await test.step("The unseated guest and the reason are shown under a clear heading", async () => {
      const current = (await weddingData.listPlanVersions(w)).find((v) => v.isCurrent)!;
      const detail = await weddingData.getPlanVersionDetail(w, current.id);
      expect(detail.unassignedGuestIds).toHaveLength(1);
      const unseatedName = names.get(detail.unassignedGuestIds[0])!;
      await expect(plan.generateWarnings()).toContainText("Couldn't seat everyone:");
      await expect(plan.generateWarnings()).toContainText(unseatedName);
      await expect(plan.generateWarnings()).toContainText("no table has enough remaining capacity");
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.says-and-counts-what-really-happened.older-version-counts-only-attending-seats",
    title: "an older version's \"seated\" count leaves out a guest who has since declined",
    objective:
      "Confirms (TS-197) that after a guest seated in version 1 is marked not attending (version 2 being current), version 1's detail counts only attending guests' seats -- it still holds the declined guest's seat, which used to be counted -- in the API and on the Seating plan tab.",
    expectedOutcome:
      "Version 1's assignedGuestCount is 1 (it holds 2 seats) and unassignedGuestCount 0; opening version 1 on the tab shows '1 seated, 0 unassigned'.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS", "REQ-DAY-OF-EMERGENCY-MODE"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:day-of-mode", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const decliner = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "Table 1", capacity: 4 });
    const v1 = await weddingData.generatePlanVersion(w);
    expect(v1.assignments).toHaveLength(2);
    await weddingData.generatePlanVersion(w);

    await test.step("A guest seated in version 1 declines", async () => {
      expect((await weddingData.setAttendance(w, decliner.id, "NOT_ATTENDING")).status).toBe(200);
    });

    await test.step("Version 1 counts only the attending guest's seat", async () => {
      const detail = await weddingData.getPlanVersionDetail(w, v1.id);
      expect(detail.assignments).toHaveLength(2);
      expect(detail.assignedGuestCount).toBe(1);
      expect(detail.unassignedGuestCount).toBe(0);
    });

    const plan = new PlanTabPage(page);
    await test.step("The Seating plan tab shows the same count for version 1", async () => {
      await plan.goto(w);
      await plan.selectVersion(/^v1 /);
      await expect(plan.openVersionBadge(1)).toBeVisible();
      await expect(plan.seatedSummary()).toHaveText("1 seated, 0 unassigned");
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.says-and-counts-what-really-happened.import-adding-a-guest-moves-the-plan-on",
    title: "an import that adds an attending guest moves the current plan on a revision, so a move from an older copy is refused",
    objective:
      "Confirms (TS-197) that committing a guest import that only adds a new attending guest gives the current plan a new revision (it has someone new to seat, and an approved plan already showed it as modified) -- so a move sent with the revision from before the import is refused as a stale copy instead of acting on a plan that has changed.",
    expectedOutcome:
      "The import answers 200; the plan's revision is one higher and the new guest is in its unassigned list; a move with the old revision gets 409 'This plan changed since you loaded it…', and one with the new revision gets 200.",
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT", "REQ-MANUAL-ADJUSTMENT"],
    tags: ["@mutating", "@feature:guests", "@feature:seating-plan", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const w = managedWedding.id;
    const seated = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    const table = await weddingData.createTable(w, { label: "Table 1", capacity: 4 });
    const plan = await weddingData.generatePlanVersion(w);
    const before = await weddingData.getPlanVersionDetail(w, plan.id);
    const newcomer = uniquePersonName(testInfo.workerIndex);

    await test.step("Import one new attending guest", async () => {
      const res = await context.request.post(`/api/v1/weddings/${w}/guests/import/commit`, {
        data: {
          csv: `firstName,lastName\n${newcomer.firstName},${newcomer.lastName}\n`,
          mapping: { firstName: "firstName", lastName: "lastName" },
        },
      });
      expect(res.status(), await res.text()).toBe(200);
    });

    await test.step("The plan moved on a revision, so the older copy is refused", async () => {
      const after = await weddingData.getPlanVersionDetail(w, plan.id);
      expect(after.revision).toBe(before.revision + 1);
      expect(after.unassignedGuestIds).toHaveLength(1);
      const newcomerId = after.unassignedGuestIds[0];
      const stale = await weddingData.moveGuestAssignment(w, plan.id, newcomerId, table.id, before.revision);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(STALE);
      const fresh = await weddingData.moveGuestAssignment(w, plan.id, newcomerId, table.id, after.revision);
      expect(fresh.status).toBe(200);
      expect(fresh.body.planVersion!.assignments.map((a) => a.guestId).sort()).toEqual([seated.id, newcomerId].sort());
    });
  },
);

defineQualityTest(
  {
    id: "seating-plan.says-and-counts-what-really-happened.made-current-notice-and-comment-couple-permission",
    title: "the Seating plan tab says when a comparison draft was made the current plan, and a Couple member with Comment access asking Draft/In review is told they don't have permission",
    objective:
      "Confirms (TS-197) that when a Generate asking for a comparison draft reaches a wedding with no current plan (the request is changed on its way here, as the tab only offers the choice once a plan exists), the tab shows the server's notice that the version was made the current plan; and that a Couple member with Comment access asking to move the plan from Draft to In review -- with or without the revision they saw -- gets 403 \"You don't have permission to do that\", not the \"isn't approved any more\" conflict.",
    expectedOutcome:
      "The notice 'There was no current plan yet, so this version was made the current plan rather than a comparison draft.' shows and the plan is current. Both status requests answer 403 with \"You don't have permission to do that\", and the plan is still a Draft.",
    requirementIds: ["REQ-PLAN-REVIEW-STATUS"],
    tags: ["@mutating", "@feature:seating-plan", "@feature:collaboration", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, page }, testInfo) => {
    const w = managedWedding.id;
    await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
    await weddingData.createTable(w, { label: "Table 1", capacity: 4 });

    const plan = new PlanTabPage(page);
    await test.step("A Generate asking for a comparison draft, with no plan yet, is made current and the tab says so", async () => {
      await plan.goto(w);
      const asDraft = await rewriteRequestJson(page, /\/plan-versions\/generate$/, "POST", (body) => ({ ...body, makeCurrent: false }));
      await plan.generate();
      expect(asDraft.hits).toBe(1);
      await asDraft.clear();
      await expect(plan.madeCurrentNotice()).toHaveText(
        "There was no current plan yet, so this version was made the current plan rather than a comparison draft.",
      );
      const versions = await weddingData.listPlanVersions(w);
      expect(versions).toHaveLength(1);
      expect(versions[0].isCurrent).toBe(true);
    });

    const planId = (await weddingData.listPlanVersions(w))[0].id;
    const coupleContext = await playwrightRequest.newContext({ baseURL: getEnv().APP_URL });
    try {
      await test.step("A Couple member with Comment access asking Draft to In review is refused for permission", async () => {
        const couple = await signUpFreshAccount(coupleContext, testInfo.workerIndex);
        await weddingData.addCollaborator(w, couple.email, "COMMENT", "COUPLE");
        const { revision } = await weddingData.getPlanVersionDetail(w, planId);
        for (const data of [{ status: "IN_REVIEW", expectedRevision: revision }, { status: "IN_REVIEW" }]) {
          const res = await coupleContext.post(`/api/v1/weddings/${w}/plan-versions/${planId}/status`, { data });
          expect(res.status()).toBe(403);
          expect(((await res.json()) as { error: string }).error).toBe("You don't have permission to do that");
        }
        expect((await weddingData.getPlanVersionDetail(w, planId)).status).toBe("DRAFT");
      });
    } finally {
      await coupleContext.dispose();
    }
  },
);
