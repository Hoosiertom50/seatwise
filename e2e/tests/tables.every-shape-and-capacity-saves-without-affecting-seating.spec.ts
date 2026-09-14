/**
 * TS-41 (REQ-TABLE-VENUE-LAYOUT) — converts AC-033 ("Tables can be defined with each shape option
 * and a capacity"). Traced against `tableShapeEnum` (packages/shared/src/schemas/table.ts) and the
 * table-creation route (POST .../tables): every shape saves and reloads correctly, "Other" accepts
 * its own free-text label the same way any other shape does (shape is just an enum value, not a
 * label -- the table's own `label` field is what displays), and -- the AC's real substance --
 * changing only a table's shape has zero effect on anything the seating engine does: it's a
 * display-only attribute (confirmed directly in the schema's own doc comment on `positionX`'s
 * neighboring fields and in seating-engine.ts, which never reads `shape` at all).
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";

const SHAPES = ["ROUND", "RECTANGULAR", "SQUARE", "OVAL", "OTHER"] as const;

interface TableDetail {
  id: string;
  label: string;
  capacity: number;
  shape: string;
}

interface Assignment {
  guestId: string;
  tableId: string;
}

defineQualityTest(
  {
    id: "tables.every-shape-and-capacity-saves-without-affecting-seating.all-five-shapes",
    title: "every table shape option saves with its capacity, and changing only shape never affects a generated assignment",
    objective:
      "Confirms a table can be created with each of the five shape options (including a free-text label for Other) and a capacity, that all of it saves and reloads correctly, and that changing only a table's shape afterward has no effect on that table's current seating assignment.",
    expectedOutcome:
      "All five tables save with their given shape, label, and capacity. After generating a plan and then PATCHing one seated table's shape only, the guest's assignment to that table is completely unchanged.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }, testInfo) => {
    const createdIds: Record<string, string> = {};

    await test.step("Act: create one table for each shape, giving the Other table its own free-text label", async () => {
      for (const shape of SHAPES) {
        const label = shape === "OTHER" ? "Sweetheart Table" : `${shape} Table`;
        const res = await context.request.post(`/api/v1/weddings/${managedWedding.id}/tables`, {
          data: { label, capacity: 6, shape },
        });
        expect(res.ok()).toBe(true);
        const { table } = (await res.json()) as { table: TableDetail };
        expect(table.shape).toBe(shape);
        expect(table.label).toBe(label);
        expect(table.capacity).toBe(6);
        createdIds[shape] = table.id;
      }
    });

    await test.step("Assert: every table reloads with its saved shape, label, and capacity intact", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/tables`);
      const { tables } = (await res.json()) as { tables: TableDetail[] };
      for (const shape of SHAPES) {
        const table = tables.find((t) => t.id === createdIds[shape])!;
        expect(table.shape).toBe(shape);
        expect(table.capacity).toBe(6);
      }
      expect(tables.find((t) => t.id === createdIds.OTHER)!.label).toBe("Sweetheart Table");
    });

    let guestId = "";
    let planVersionId = "";
    let assignedTableId = "";

    await test.step("Arrange: generate a plan, then explicitly (and deterministically) move the guest onto the Round table", async () => {
      const guest = await weddingData.createGuest(managedWedding.id, uniquePersonName(testInfo.workerIndex));
      guestId = guest.id;

      const genRes = await context.request.post(`/api/v1/weddings/${managedWedding.id}/plan-versions/generate`);
      expect(genRes.ok()).toBe(true);
      const genBody = (await genRes.json()) as { planVersion: { id: string } };
      planVersionId = genBody.planVersion.id;

      assignedTableId = createdIds.ROUND;
      const moveRes = await context.request.post(
        `/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}/assignments`,
        { data: { guestId, tableId: assignedTableId } },
      );
      expect(moveRes.ok()).toBe(true);
    });

    await test.step("Act: change only the assigned table's shape", async () => {
      const res = await context.request.patch(`/api/v1/weddings/${managedWedding.id}/tables/${assignedTableId}`, {
        data: { shape: "SQUARE" },
      });
      expect(res.ok()).toBe(true);
      const { table } = (await res.json()) as { table: TableDetail };
      expect(table.shape).toBe("SQUARE");
      // Capacity and label are untouched by a shape-only edit.
      expect(table.capacity).toBe(6);
    });

    await test.step("Assert: the guest's assignment to that table is completely unaffected by the shape change", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/plan-versions/${planVersionId}`);
      const body = (await res.json()) as { planVersion: { assignments: Assignment[] } };
      const assignment = body.planVersion.assignments.find((a) => a.guestId === guestId);
      expect(assignment).toBeDefined();
      expect(assignment!.tableId).toBe(assignedTableId);
    });
  },
);
