/**
 * TS-54 (REQ-CROSS-CUTTING-HARD-RULE-INVARIANT) — converts AC-001 ("Hard rules cannot be violated
 * by any direct action"). The workbook's own test steps sweep five kinds of direct action across
 * every hard-rule type (capacity, must-sit-together, must-not-sit-together, a Restricted table's
 * required-guest list in both directions, and a Requires-Accessible-Table guest) and expect each
 * to be blocked before saving, with no assignment change and no override offered.
 *
 * "Direct action" here is the manual seat-move endpoint (TS-10, `POST
 * .../plan-versions/:id/assignments`) -- the one place a user can directly relocate an already-
 * generated guest, and the one this invariant is actually enforced in (read directly from
 * packages/db/src/queries/plan-versions.ts's `moveGuestAssignment`). Exercised via a direct API
 * call rather than drag-and-drop, since the invariant lives in that endpoint regardless of which
 * UI gesture calls it, and TS-44 (Manual Adjustment) is the right place for the drag-and-drop
 * interaction itself.
 *
 * One nuance confirmed by reading the engine code (not assumed): "attempt to separate one member
 * of the Must-Sit-Together group" doesn't produce a distinct "you can't separate this group"
 * error. The endpoint always moves a guest's *entire* forced-together unit as one atomic move, so
 * there's no request that could land only one member somewhere else -- the group is *never*
 * separable, not even temporarily. Proving that requires a target table too small for the whole
 * unit, which blocks for the capacity reason (the message still names the group explicitly and
 * says "everyone in this must-sit-together group moves together"). This is a stronger guarantee
 * than the literal test-case wording describes, not a gap -- noted here so a future reader isn't
 * confused about why this scenario's blocking reason is "capacity" rather than "separation".
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface Assignment {
  guestId: string;
  tableId: string;
}

defineQualityTest(
  {
    id: "cross-cutting-invariant.hard-rules-block-every-direct-manual-move.six-scenarios",
    title: "every kind of hard-rule-violating manual move is blocked, unchanged, with no override",
    objective:
      "Confirms the manual seat-move endpoint blocks every direct action that would violate a hard rule -- over capacity, breaking a must-sit-together unit apart, seating a must-not-sit-together pair together, adding an unlisted guest to a Restricted table, moving a required guest off a Restricted table, and moving a Requires-Accessible-Table guest to a non-accessible table -- and that each blocked attempt leaves every assignment exactly as it was.",
    expectedOutcome:
      "All six attempts return an error (never a 200) that names the affected guest(s) and table, and the plan version's assignments are byte-for-byte the same afterward as they were before any attempt.",
    requirementIds: ["REQ-CROSS-CUTTING-HARD-RULE-INVARIANT"],
    tags: ["@mutating", "@feature:manual-adjustment", "@feature:seating-plan", "@risk:critical", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let planVersionId = "";

    const move = async (guestId: string, tableId: string) =>
      context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`, {
        data: { guestId, tableId },
      });

    const currentAssignments = async (): Promise<Assignment[]> => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { planVersion: { assignments: Assignment[] } };
      return body.planVersion.assignments;
    };

    // Names, not identifiers, are asserted against blocked-move error text below, so every guest
    // needs a name distinct enough that a substring match can't accidentally hit the wrong one.
    const gFull = uniquePersonName(testInfo.workerIndex);
    const gExtra = uniquePersonName(testInfo.workerIndex);
    const gMustA = uniquePersonName(testInfo.workerIndex);
    const gMustB = uniquePersonName(testInfo.workerIndex);
    const gNotA = uniquePersonName(testInfo.workerIndex);
    const gNotB = uniquePersonName(testInfo.workerIndex);
    const gRequired = uniquePersonName(testInfo.workerIndex);
    const gOutsider = uniquePersonName(testInfo.workerIndex);
    const gAccess = uniquePersonName(testInfo.workerIndex);

    let tableFull = "";
    let tableUnitHome = "";
    let tableTooSmall = "";
    let tableNotA = "";
    let tableNotB = "";
    let tableRestricted = "";
    let tableAccessible = "";
    let tableNotAccessible = "";
    let idFull = "";
    let idExtra = "";
    let idMustA = "";
    let idMustB = "";
    let idNotA = "";
    let idNotB = "";
    let idRequired = "";
    let idOutsider = "";
    let idAccess = "";

    await test.step("Arrange: a Current plan version (generation refuses to run with zero guests/tables, so a throwaway pair seeds it -- every real scenario table below is created afterward, starting empty, so every placement is an explicit, deterministic move never left to the generation engine's own choice)", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      await weddingData.createTable(managedWedding.id, { label: "Decoy", capacity: 1 });
      const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { planVersion: { id: string; isComplete: boolean } };
      planVersionId = body.planVersion.id;
      expect(body.planVersion.isComplete).toBe(true); // the decoy guest fills the decoy table exactly.
    });

    await test.step("Arrange: one table per hard-rule scenario", async () => {
      tableFull = (await weddingData.createTable(managedWedding.id, { label: "Full Table", capacity: 1 })).id;
      tableUnitHome = (await weddingData.createTable(managedWedding.id, { label: "Unit Home", capacity: 2 })).id;
      tableTooSmall = (await weddingData.createTable(managedWedding.id, { label: "Too Small For The Unit", capacity: 1 })).id;
      tableNotA = (await weddingData.createTable(managedWedding.id, { label: "Not-Together A", capacity: 8 })).id;
      tableNotB = (await weddingData.createTable(managedWedding.id, { label: "Not-Together B", capacity: 8 })).id;
      tableRestricted = (
        await weddingData.createTable(managedWedding.id, { label: "Restricted", capacity: 8, isRestricted: true })
      ).id;
      tableAccessible = (
        await weddingData.createTable(managedWedding.id, { label: "Accessible", capacity: 8, isAccessible: true })
      ).id;
      tableNotAccessible = (
        await weddingData.createTable(managedWedding.id, { label: "Not Accessible", capacity: 8 })
      ).id;
    });

    await test.step("Arrange: one guest per role", async () => {
      idFull = (await weddingData.createGuest(managedWedding.id, gFull)).id;
      idExtra = (await weddingData.createGuest(managedWedding.id, gExtra)).id;
      idMustA = (await weddingData.createGuest(managedWedding.id, gMustA)).id;
      idMustB = (await weddingData.createGuest(managedWedding.id, gMustB)).id;
      idNotA = (await weddingData.createGuest(managedWedding.id, gNotA)).id;
      idNotB = (await weddingData.createGuest(managedWedding.id, gNotB)).id;
      idRequired = (await weddingData.createGuest(managedWedding.id, gRequired)).id;
      idOutsider = (await weddingData.createGuest(managedWedding.id, gOutsider)).id;
      idAccess = (
        await weddingData.createGuest(managedWedding.id, { ...gAccess, requiresAccessibleTable: true })
      ).id;
    });

    await test.step("Arrange: the rules that make each later move a hard-rule violation", async () => {
      await weddingData.createRelationship(managedWedding.id, idMustA, idMustB, "MUST_SIT_TOGETHER");
      await weddingData.createRelationship(managedWedding.id, idNotA, idNotB, "MUST_NOT_SIT_TOGETHER");
      await weddingData.setRequiredGuests(managedWedding.id, tableRestricted, [idRequired]);
    });

    await test.step("Arrange: place every guest at their valid starting table (each move must succeed here)", async () => {
      expect((await move(idFull, tableFull)).status()).toBe(200);
      // Moving just idMustA also moves idMustB -- they're a forced-together unit.
      expect((await move(idMustA, tableUnitHome)).status()).toBe(200);
      expect((await move(idNotA, tableNotA)).status()).toBe(200);
      expect((await move(idNotB, tableNotB)).status()).toBe(200);
      expect((await move(idRequired, tableRestricted)).status()).toBe(200);
      expect((await move(idAccess, tableAccessible)).status()).toBe(200);
    });

    const before = await test.step("Record the starting assignments", async () => currentAssignments());

    await test.step("Assert: adding a guest to a full table is blocked", async () => {
      const res = await move(idExtra, tableFull);
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(gExtra.firstName);
      expect(body.error).toContain("Full Table");
    });

    await test.step("Assert: moving one member of a must-sit-together unit somewhere too small for the whole unit is blocked -- the group can never be separated, not even by a move that only names one of them", async () => {
      const res = await move(idMustA, tableTooSmall);
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(gMustA.firstName);
      expect(body.error).toContain(gMustB.firstName);
      expect(body.error).toContain("must-sit-together group moves together");
    });

    await test.step("Assert: seating a must-not-sit-together pair at the same table is blocked", async () => {
      const res = await move(idNotA, tableNotB);
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(gNotA.firstName);
      expect(body.error).toContain('must not sit together" rule with');
      expect(body.error).toContain(gNotB.firstName);
    });

    await test.step("Assert: adding an unlisted guest to a Restricted table is blocked", async () => {
      const res = await move(idOutsider, tableRestricted);
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Restricted");
      expect(body.error).toContain(gOutsider.firstName);
    });

    await test.step("Assert: moving a required guest off their Restricted table is blocked", async () => {
      const res = await move(idRequired, tableNotA);
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(gRequired.firstName);
      expect(body.error).toContain("is required at");
    });

    await test.step("Assert: moving a Requires-Accessible-Table guest to a non-accessible table is blocked", async () => {
      const res = await move(idAccess, tableNotAccessible);
      expect(res.status()).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(gAccess.firstName);
      expect(body.error).toContain("accessible table");
    });

    await test.step("Assert: no assignment changed across all six blocked attempts", async () => {
      const after = await currentAssignments();
      expect(after).toEqual(before);
    });
  },
);
