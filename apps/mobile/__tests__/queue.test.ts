import { createInMemoryStore } from "../src/offline/storage";
import {
  enqueueMove,
  loadQueue,
  readCachedPlan,
  rebaseQueue,
  replayQueue,
  saveQueue,
  writeCachedPlan,
  type QueuedMove,
} from "../src/offline/queue";
import { MoveConflictError, MoveRejectedError } from "../src/api/planVersions";
import { NetworkError } from "../src/api/client";
import { makePlanVersion } from "./testFixtures";

function move(overrides: Partial<QueuedMove> & { guestId: string; expectedRevision: number }): QueuedMove {
  return {
    guestName: "Guest",
    tableId: "t1",
    tableLabel: "Table 1",
    queuedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("enqueueMove / loadQueue / saveQueue", () => {
  it("persists moves per-wedding and returns them in order", async () => {
    const store = createInMemoryStore();
    await enqueueMove(store, "w1", move({ guestId: "g1", expectedRevision: 0 }));
    await enqueueMove(store, "w1", move({ guestId: "g2", expectedRevision: 1 }));
    // A different wedding's queue is entirely separate.
    await enqueueMove(store, "w2", move({ guestId: "g9", expectedRevision: 0 }));

    expect((await loadQueue(store, "w1")).map((m) => m.guestId)).toEqual(["g1", "g2"]);
    expect((await loadQueue(store, "w2")).map((m) => m.guestId)).toEqual(["g9"]);

    await saveQueue(store, "w1", []);
    expect(await loadQueue(store, "w1")).toEqual([]);
  });
});

describe("plan cache", () => {
  it("round-trips a cached plan version per wedding", async () => {
    const store = createInMemoryStore();
    expect(await readCachedPlan(store, "w1")).toBeNull();

    const planVersion = makePlanVersion({ id: "pv1" });
    await writeCachedPlan(store, { weddingId: "w1", planVersionId: "pv1", planVersion, cachedAt: "now" });

    const cached = await readCachedPlan(store, "w1");
    expect(cached?.planVersion.id).toBe("pv1");
  });
});

describe("rebaseQueue", () => {
  it("renumbers expectedRevision sequentially from a fresh base", () => {
    const queue = [
      move({ guestId: "g1", expectedRevision: 40 }),
      move({ guestId: "g2", expectedRevision: 41 }),
      move({ guestId: "g3", expectedRevision: 42 }),
    ];
    const rebased = rebaseQueue(queue, 10);
    expect(rebased.map((m) => m.expectedRevision)).toEqual([10, 11, 12]);
    // guestId/order preserved -- only expectedRevision changes.
    expect(rebased.map((m) => m.guestId)).toEqual(["g1", "g2", "g3"]);
  });
});

describe("replayQueue", () => {
  it("reports 'empty' for an empty queue without calling moveFn", async () => {
    const moveFn = jest.fn();
    const result = await replayQueue(moveFn, []);
    expect(result).toEqual({ outcome: "empty" });
    expect(moveFn).not.toHaveBeenCalled();
  });

  it("replays every queued move in order and reports 'synced' with the final plan version", async () => {
    const queue = [move({ guestId: "g1", expectedRevision: 0 }), move({ guestId: "g2", expectedRevision: 1 })];
    const calls: string[] = [];
    const moveFn = jest.fn(async (m: QueuedMove) => {
      calls.push(m.guestId);
      return { planVersion: makePlanVersion({ revision: m.expectedRevision + 1 }) };
    });

    const result = await replayQueue(moveFn, queue);

    expect(calls).toEqual(["g1", "g2"]);
    expect(result.outcome).toBe("synced");
    if (result.outcome === "synced") {
      expect(result.replayedCount).toBe(2);
      expect(result.planVersion.revision).toBe(2);
    }
  });

  it("stops at the first conflict, never calling moveFn for the moves after it", async () => {
    const queue = [
      move({ guestId: "g1", expectedRevision: 0 }),
      move({ guestId: "g2", expectedRevision: 1 }),
      move({ guestId: "g3", expectedRevision: 2 }),
    ];
    const freshPlanVersion = makePlanVersion({ revision: 9 });
    const moveFn = jest.fn(async (m: QueuedMove) => {
      if (m.guestId === "g2") throw new MoveConflictError("stale revision", freshPlanVersion);
      return { planVersion: makePlanVersion({ revision: m.expectedRevision + 1 }) };
    });

    const result = await replayQueue(moveFn, queue);

    expect(moveFn).toHaveBeenCalledTimes(2); // g1 (succeeded), g2 (conflicted) -- g3 never attempted
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") {
      expect(result.replayedCount).toBe(1);
      expect(result.remaining.map((m) => m.guestId)).toEqual(["g2", "g3"]);
      expect(result.planVersion).toBe(freshPlanVersion);
    }
  });

  it("stops at a rejection and reports which move + how many succeeded first", async () => {
    const queue = [
      move({ guestId: "g1", expectedRevision: 0 }),
      move({ guestId: "g2", expectedRevision: 1 }),
      move({ guestId: "g3", expectedRevision: 2 }),
    ];
    const moveFn = jest.fn(async (m: QueuedMove) => {
      if (m.guestId === "g2") throw new MoveRejectedError("Table is full");
      return { planVersion: makePlanVersion({ revision: m.expectedRevision + 1 }) };
    });

    const result = await replayQueue(moveFn, queue);

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.replayedCount).toBe(1);
      expect(result.move.guestId).toBe("g2");
      expect(result.message).toBe("Table is full");
      expect(result.remaining.map((m) => m.guestId)).toEqual(["g3"]);
    }
  });

  it("stops on a network failure and preserves the untried remainder (including the one in flight)", async () => {
    const queue = [move({ guestId: "g1", expectedRevision: 0 }), move({ guestId: "g2", expectedRevision: 1 })];
    const moveFn = jest.fn(async () => {
      throw new NetworkError();
    });

    const result = await replayQueue(moveFn, queue);

    expect(result.outcome).toBe("offline");
    if (result.outcome === "offline") {
      expect(result.replayedCount).toBe(0);
      expect(result.remaining.map((m) => m.guestId)).toEqual(["g1", "g2"]);
    }
  });

  it("rethrows an unrecognized error rather than silently swallowing it", async () => {
    const queue = [move({ guestId: "g1", expectedRevision: 0 })];
    const moveFn = jest.fn(async () => {
      throw new Error("boom");
    });
    await expect(replayQueue(moveFn, queue)).rejects.toThrow("boom");
  });
});
