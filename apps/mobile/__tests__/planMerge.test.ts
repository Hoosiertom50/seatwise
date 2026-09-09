import { applyLocalMove, buildFloorPlanViewModel } from "../src/planMerge";
import { makeGuest, makePlanVersion, makeTable } from "./testFixtures";

describe("buildFloorPlanViewModel", () => {
  it("groups seated guests under their table and lists everyone else as unassigned", () => {
    const alice = makeGuest({ id: "g1", firstName: "Alice" });
    const bob = makeGuest({ id: "g2", firstName: "Bob" });
    const carol = makeGuest({ id: "g3", firstName: "Carol" });
    const table1 = makeTable({ id: "t1", label: "Table 1" });
    const table2 = makeTable({ id: "t2", label: "Table 2" });

    const planVersion = makePlanVersion({
      assignments: [
        { id: "a1", guestId: "g1", guestName: "Alice", tableId: "t1", tableLabel: "Table 1", needsReassignment: false },
        { id: "a2", guestId: "g2", guestName: "Bob", tableId: "t1", tableLabel: "Table 1", needsReassignment: true },
      ],
      unassignedGuestIds: ["g3"],
    });

    const vm = buildFloorPlanViewModel([table1, table2], [alice, bob, carol], planVersion);

    expect(vm.tables).toHaveLength(2);
    const t1 = vm.tables.find((t) => t.table.id === "t1")!;
    const t2 = vm.tables.find((t) => t.table.id === "t2")!;
    expect(t1.seated.map((s) => s.guest.id)).toEqual(["g1", "g2"]);
    expect(t1.seated.find((s) => s.guest.id === "g2")!.needsReassignment).toBe(true);
    expect(t2.seated).toHaveLength(0);
    expect(vm.unassigned.map((s) => s.guest.id)).toEqual(["g3"]);
  });

  it("flags a locally-queued/optimistic assignment as pending sync", () => {
    const alice = makeGuest({ id: "g1" });
    const table1 = makeTable({ id: "t1" });
    const planVersion = makePlanVersion({
      assignments: [
        { id: "local:g1", guestId: "g1", guestName: "Alice", tableId: "t1", tableLabel: "Table 1", needsReassignment: false },
      ],
    });

    const vm = buildFloorPlanViewModel([table1], [alice], planVersion);
    expect(vm.tables[0].seated[0].pendingSync).toBe(true);
  });

  it("skips an assignment referencing a guest or table this device hasn't cached, rather than crashing", () => {
    const table1 = makeTable({ id: "t1" });
    const planVersion = makePlanVersion({
      assignments: [
        { id: "a1", guestId: "unknown-guest", guestName: "?", tableId: "t1", tableLabel: "Table 1", needsReassignment: false },
        { id: "a2", guestId: "g1", guestName: "Alice", tableId: "unknown-table", tableLabel: "?", needsReassignment: false },
      ],
    });

    const vm = buildFloorPlanViewModel([table1], [makeGuest({ id: "g1" })], planVersion);
    expect(vm.tables[0].seated).toHaveLength(0);
  });
});

describe("applyLocalMove", () => {
  it("moves a guest from unassigned to a table and bumps the local revision by 1", () => {
    const alice = makeGuest({ id: "g1", firstName: "Alice", lastName: "A" });
    const table1 = makeTable({ id: "t1", label: "Table 1" });
    const planVersion = makePlanVersion({ unassignedGuestIds: ["g1"], revision: 4 });

    const next = applyLocalMove(planVersion, alice, "t1", table1);

    expect(next.revision).toBe(5);
    expect(next.unassignedGuestIds).not.toContain("g1");
    expect(next.assignments).toEqual([
      { id: "local:g1", guestId: "g1", guestName: "Alice A", tableId: "t1", tableLabel: "Table 1", needsReassignment: false },
    ]);
  });

  it("moves a guest between two tables, replacing their old assignment", () => {
    const alice = makeGuest({ id: "g1" });
    const table2 = makeTable({ id: "t2", label: "Table 2" });
    const planVersion = makePlanVersion({
      assignments: [
        { id: "a1", guestId: "g1", guestName: "Alice", tableId: "t1", tableLabel: "Table 1", needsReassignment: false },
      ],
      revision: 2,
    });

    const next = applyLocalMove(planVersion, alice, "t2", table2);

    expect(next.assignments).toHaveLength(1);
    expect(next.assignments[0].tableId).toBe("t2");
    expect(next.revision).toBe(3);
  });

  it("moves a guest back to unassigned when toTableId is null", () => {
    const alice = makeGuest({ id: "g1" });
    const planVersion = makePlanVersion({
      assignments: [
        { id: "a1", guestId: "g1", guestName: "Alice", tableId: "t1", tableLabel: "Table 1", needsReassignment: false },
      ],
      revision: 1,
    });

    const next = applyLocalMove(planVersion, alice, null, undefined);

    expect(next.assignments).toHaveLength(0);
    expect(next.unassignedGuestIds).toEqual(["g1"]);
    expect(next.revision).toBe(2);
  });
});
