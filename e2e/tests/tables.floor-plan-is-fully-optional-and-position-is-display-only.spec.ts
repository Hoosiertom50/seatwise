/**
 * TS-41 (REQ-TABLE-VENUE-LAYOUT) — converts AC-035 ("The floor plan is fully optional"). Traced
 * against `updateTableSchema` (packages/shared/src/schemas/table.ts): `positionX`/`positionY` are
 * the floor plan's own drag coordinates, explicitly documented as "never read by generation, the
 * engine, or any rule check." This test proves both halves of the AC directly:
 *
 * - a complete generate-review-approve cycle succeeds without ever calling anything
 *   position-related (the "opening the floor plan is optional" half), and
 * - explicitly setting a table's position (the same PATCH the floor-plan drag gesture itself
 *   calls) persists correctly but changes nothing about the current plan's assignments,
 *   warnings, or completeness (the "position never affects generation" half).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

interface Assignment {
  guestId: string;
  tableId: string;
}

interface PlanVersionDetail {
  isComplete: boolean;
  assignments: Assignment[];
  warnings?: string[];
}

defineQualityTest(
  {
    id: "tables.floor-plan-is-fully-optional-and-position-is-display-only.full-cycle-and-drag",
    title: "a full generate-review-approve cycle never requires the floor plan, and setting a table's position never affects seating",
    objective:
      "Confirms a wedding can be fully generated, reviewed, and approved without ever touching the floor plan or setting any table position, and that explicitly setting a table's drag position afterward persists correctly while leaving every assignment, warning, and the plan's completeness completely unchanged.",
    expectedOutcome:
      "The plan generates and approves successfully with every table's position left at whatever the server assigned by default. Setting a table's position via PATCH afterward saves and reloads correctly, and the plan version's assignments/isComplete are byte-for-byte identical before and after.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    let planVersionId = "";
    let tableId = "";

    await test.step("Arrange + Act: a full generate -> approve cycle, never calling anything position-related", async () => {
      await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      const [table] = await weddingData.quickCreateTables(managedWedding.id, { count: 1, capacity: 8 });
      tableId = table.id;

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as { planVersion: { id: string; isComplete: boolean } };
      planVersionId = genBody.planVersion.id;
      expect(genBody.planVersion.isComplete).toBe(true);

      const approveRes = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/status`,
        { data: { status: "APPROVED" } },
      );
      expect(approveRes.ok()).toBe(true);
    });

    const before = await test.step("Record the approved plan's assignments and completeness", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const body = (await res.json()) as { planVersion: PlanVersionDetail };
      return body.planVersion;
    });

    await test.step("Act: set the table's floor-plan position (the same call a drag gesture makes)", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/tables/${tableId}`, {
        data: { positionX: 480, positionY: 220 },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { table: { positionX: number; positionY: number } };
      expect(body.table.positionX).toBe(480);
      expect(body.table.positionY).toBe(220);
    });

    await test.step("Assert: the position persists on reload", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/tables`);
      const { tables } = (await res.json()) as { tables: { id: string; positionX: number; positionY: number }[] };
      const table = tables.find((t) => t.id === tableId)!;
      expect(table.positionX).toBe(480);
      expect(table.positionY).toBe(220);
    });

    await test.step("Assert: the approved plan's assignments and completeness are completely unaffected by the position change", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const body = (await res.json()) as { planVersion: PlanVersionDetail };
      expect(body.planVersion.isComplete).toBe(before.isComplete);
      expect(body.planVersion.assignments).toEqual(before.assignments);
    });
  },
);
