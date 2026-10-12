/**
 * TS-189 (REQ-PLAN-REVIEW-STATUS, REQ-MANUAL-ADJUSTMENT, REQ-AUTOMATED-SEAT-ASSIGNMENT,
 * REQ-COLLABORATION-NOTIFICATIONS) — plan versions report what really happened:
 * - A comparison draft asked for when there's no current plan is made the current plan (and the
 *   response says so); once there is one, a draft stays a draft.
 * - A version that stops being current gets a new revision, so a copy of it open elsewhere (another
 *   tab) is refused as changed and shown the version as it is now -- no longer current. Adding a
 *   guest moves the current plan's revision on too.
 * - Moving a guest to the table they're already at, or unseating a guest who has no seat, changes
 *   nothing: same revision, no history line.
 * - Undoing an approval back to In review tells collaborators the approval was undone (not that the
 *   plan was shared for review), and the history says it in words.
 */

import { request as playwrightRequest } from "@playwright/test";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName, uniqueTitle } from "../data/ids.js";
import { signUpFreshAccount } from "../support/auth.js";
import { getEnv } from "../support/env.js";

const MADE_CURRENT_NOTICE =
  "There was no current plan yet, so this version was made the current plan rather than a comparison draft.";
const STALE = /^This plan changed since you loaded it/;

interface GenerateBody {
  planVersion: { id: string; isCurrent: boolean; revision: number };
  madeCurrentBecauseNoCurrentPlan: boolean;
  notice?: string;
}

defineQualityTest(
  {
    id: "plan-review.plan-versions-report-what-really-happened.draft-revision-no-op-reopen",
    title: "a first comparison draft becomes the current plan, a replaced version is refused as changed, no-op moves record nothing, and undoing an approval says so",
    objective:
      "Confirms that a Generate asking for a comparison draft on a wedding with no current plan makes the new version current and says so, while a later one stays a draft; that the version a Generate replaces gets a new revision, so a rename sent from a copy loaded before is refused with the fresh, no-longer-current version; that adding a guest moves the current plan's revision on, so a move from an older copy is refused; that moving a guest to the table they're already at and unseating a guest with no seat leave the revision and the history unchanged; and that moving an approved plan back to In review notifies collaborators that the approval was undone (STATUS_CHANGED, not PLAN_SHARED) and is recorded as 'Status changed from Approved to In review'.",
    expectedOutcome:
      "First draft Generate: 201, isCurrent true, madeCurrentBecauseNoCurrentPlan true, the notice. Second: isCurrent false, flag false. The replaced version's revision is one higher and isCurrent false; the stale rename gets 409 with planVersion.isCurrent false. After adding a guest, a move with the earlier revision gets 409. The no-op move and no-op unseat return 200 with the same revision and the activity count unchanged. The collaborator gets a STATUS_CHANGED 'The seating plan's approval was undone — it's back in review.' and no PLAN_SHARED; the newest history line reads 'Status changed from Approved to In review'.",
    requirementIds: [
      "REQ-PLAN-REVIEW-STATUS",
      "REQ-MANUAL-ADJUSTMENT",
      "REQ-AUTOMATED-SEAT-ASSIGNMENT",
      "REQ-COLLABORATION-NOTIFICATIONS",
    ],
    tags: ["@mutating", "@feature:seating-plan", "@feature:manual-adjustment", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    test.setTimeout(120_000);
    const person = () => uniquePersonName(testInfo.workerIndex);
    const w = (await weddingData.createWedding(uniqueTitle(testInfo.workerIndex, "Plan Versions Report"))).id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const generate = async (makeCurrent: boolean) => {
      const res = await context.request.post(api("plan-versions/generate"), { data: { makeCurrent } });
      expect(res.status()).toBe(201);
      return (await res.json()) as GenerateBody;
    };
    const table = await weddingData.createTable(w, { label: "Table 1", capacity: 8 });
    await weddingData.createTable(w, { label: "Table 2", capacity: 8 });
    const seated = await weddingData.createGuest(w, person());
    await weddingData.createGuest(w, person());

    let firstId = "";
    await test.step("A comparison draft with no current plan is made current; the next one stays a draft", async () => {
      const first = await generate(false);
      expect(first.planVersion.isCurrent).toBe(true);
      expect(first.madeCurrentBecauseNoCurrentPlan).toBe(true);
      expect(first.notice).toBe(MADE_CURRENT_NOTICE);
      firstId = first.planVersion.id;

      const second = await generate(false);
      expect(second.planVersion.isCurrent).toBe(false);
      expect(second.madeCurrentBecauseNoCurrentPlan).toBe(false);
      expect((await weddingData.listPlanVersions(w)).find((v) => v.isCurrent)!.id).toBe(firstId);
    });

    let currentId = "";
    await test.step("The replaced version moves to a new revision, so an older copy of it is refused", async () => {
      const before = await weddingData.getPlanVersionDetail(w, firstId);
      const replacing = await generate(true);
      currentId = replacing.planVersion.id;
      const after = await weddingData.getPlanVersionDetail(w, firstId);
      expect(after.isCurrent).toBe(false);
      expect(after.revision).toBe(before.revision + 1);

      const rename = await context.request.patch(api(`plan-versions/${firstId}`), {
        data: { label: "From the other tab", expectedRevision: before.revision },
      });
      expect(rename.status()).toBe(409);
      const body = (await rename.json()) as { error: string; planVersion: { isCurrent: boolean; label: string | null } };
      expect(body.error).toMatch(STALE);
      expect(body.planVersion.isCurrent).toBe(false);
      expect(body.planVersion.label).toBeNull();
    });

    let latecomerId = "";
    await test.step("Adding a guest moves the current plan's revision on, so a move from an older copy is refused", async () => {
      const before = await weddingData.getPlanVersionDetail(w, currentId);
      const latecomer = await weddingData.createGuest(w, person());
      latecomerId = latecomer.id;
      const after = await weddingData.getPlanVersionDetail(w, currentId);
      expect(after.revision).toBe(before.revision + 1);
      const stale = await weddingData.moveGuestAssignment(w, currentId, latecomer.id, table.id, before.revision);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(STALE);
    });

    await test.step("A move to the table a guest is already at, and unseating a guest with no seat, record nothing", async () => {
      const plan = await weddingData.getPlanVersionDetail(w, currentId);
      const at = plan.assignments.find((a) => a.guestId === seated.id)!.tableId;
      const historyBefore = (await weddingData.getActivity(w)).length;

      const sameTable = await weddingData.moveGuestAssignment(w, currentId, seated.id, at, plan.revision);
      expect(sameTable.status).toBe(200);
      expect(sameTable.body.planVersion!.revision).toBe(plan.revision);

      const noSeat = await weddingData.moveGuestAssignment(w, currentId, latecomerId, null, plan.revision);
      expect(noSeat.status).toBe(200);
      expect(noSeat.body.planVersion!.revision).toBe(plan.revision);

      expect((await weddingData.getPlanVersionDetail(w, currentId)).revision).toBe(plan.revision);
      expect((await weddingData.getActivity(w)).length).toBe(historyBefore);
    });

    await test.step("Undoing an approval back to In review tells collaborators so, and the history says it in words", async () => {
      const mw = managedWedding.id;
      await weddingData.createTable(mw, { label: "Table 1", capacity: 8 });
      for (let i = 0; i < 2; i++) await weddingData.createGuest(mw, person());
      const plan = await weddingData.generatePlanVersion(mw);
      const collabCtx = await playwrightRequest.newContext({ baseURL: getEnv().APP_URL });
      try {
        const collab = await signUpFreshAccount(collabCtx, testInfo.workerIndex);
        await weddingData.addCollaborator(mw, collab.email, "EDIT");
        expect((await weddingData.setPlanVersionStatus(mw, plan.id, "APPROVED")).status).toBe(200);
        expect((await weddingData.setPlanVersionStatus(mw, plan.id, "IN_REVIEW")).status).toBe(200);

        const notes = ((await (await collabCtx.get("/api/v1/notifications")).json()) as {
          notifications: { type: string; message: string }[];
        }).notifications;
        expect(
          notes.find((n) => n.type === "STATUS_CHANGED" && n.message === "The seating plan's approval was undone — it's back in review."),
        ).toBeTruthy();
        expect(notes.filter((n) => n.type === "PLAN_SHARED")).toHaveLength(0);

        const history = await weddingData.getActivity(mw);
        expect(history[0].description).toBe("Status changed from Approved to In review");
      } finally {
        await collabCtx.dispose();
      }
    });
  },
);
