/**
 * TS-41 (REQ-TABLE-VENUE-LAYOUT) — converts AC-034 ("A standard set of tables can be created in
 * one action"). Traced against `quickCreateSeatingTables` (packages/db/src/queries/tables.ts):
 * one POST .../tables/quick-create call inserts `count` tables in a single DB transaction, each
 * with the given shape and capacity, and a label built from an auto-incrementing index continuing
 * from however many tables already exist in the wedding -- so labels are always distinct, both on
 * an empty wedding and one that already has tables.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";

interface TableDetail {
  id: string;
  label: string;
  capacity: number;
  shape: string;
}

defineQualityTest(
  {
    id: "tables.quick-create-makes-a-standard-set-in-one-action.twelve-round-tables-of-eight",
    title: "quick-create makes a full standard set of tables in one action, each with a distinct label",
    objective:
      "Confirms that quick-creating 12 Round tables of capacity 8 in a single action creates exactly 12 tables, each with shape Round, capacity 8, and its own distinct label -- and that a second quick-create call on the same wedding continues numbering rather than colliding with the first batch.",
    expectedOutcome:
      "Exactly 12 tables are created by the first call, all Round/capacity 8 with 12 distinct labels. A second quick-create call adds 3 more tables with labels that don't collide with the first 12, for 15 total.",
    requirementIds: ["REQ-TABLE-VENUE-LAYOUT"],
    tags: ["@mutating", "@feature:tables", "@risk:normal", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context }) => {
    await test.step("Act: quick-create 12 Round tables of capacity 8 in one action", async () => {
      const tables = await weddingData.quickCreateTables(managedWedding.id, { count: 12, capacity: 8 });
      expect(tables.length).toBe(12);
    });

    await test.step("Assert: exactly 12 tables exist, all Round with capacity 8, and every label is distinct", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/tables`);
      const { tables } = (await res.json()) as { tables: TableDetail[] };
      expect(tables.length).toBe(12);
      for (const table of tables) {
        expect(table.shape).toBe("ROUND");
        expect(table.capacity).toBe(8);
      }
      expect(new Set(tables.map((t) => t.label)).size).toBe(12);
    });

    await test.step("Act: quick-create 3 more tables on the same wedding", async () => {
      const more = await weddingData.quickCreateTables(managedWedding.id, { count: 3, capacity: 10 });
      expect(more.length).toBe(3);
    });

    await test.step("Assert: 15 tables total, and none of the second batch's labels collide with the first batch's", async () => {
      const res = await context.request.get(`/api/v1/weddings/${managedWedding.id}/tables`);
      const { tables } = (await res.json()) as { tables: TableDetail[] };
      expect(tables.length).toBe(15);
      expect(new Set(tables.map((t) => t.label)).size).toBe(15);
    });
  },
);
