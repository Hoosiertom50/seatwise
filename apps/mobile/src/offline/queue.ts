import type { PlanVersionDetailDTO } from "@seatwise/shared";
import { MoveConflictError, MoveRejectedError } from "../api/planVersions";
import { NetworkError } from "../api/client";
import type { KeyValueStore } from "./storage";

// FR-16.2: "moves made while offline are queued and synced ... once connectivity returns, rather
// than failing outright." One QueuedMove per manual move a planner makes while this device can't
// reach the server. expectedRevision is captured at the moment the move is made *locally* --
// since each accepted move bumps the plan version's revision by exactly 1 (see planMerge.ts's
// applyLocalMove), a run of several offline moves gets a run of consecutive expected revisions
// without needing to ask the server anything until connectivity is back.
export interface QueuedMove {
  guestId: string;
  guestName: string;
  tableId: string | null;
  tableLabel: string | null;
  expectedRevision: number;
  queuedAt: string;
}

const queueKey = (weddingId: string) => `seatwise:pendingMoves:${weddingId}`;
const cacheKey = (weddingId: string) => `seatwise:planCache:${weddingId}`;

export async function loadQueue(store: KeyValueStore, weddingId: string): Promise<QueuedMove[]> {
  const raw = await store.getItem(queueKey(weddingId));
  return raw ? (JSON.parse(raw) as QueuedMove[]) : [];
}

export async function saveQueue(store: KeyValueStore, weddingId: string, queue: QueuedMove[]): Promise<void> {
  await store.setItem(queueKey(weddingId), JSON.stringify(queue));
}

export async function enqueueMove(
  store: KeyValueStore,
  weddingId: string,
  move: QueuedMove
): Promise<QueuedMove[]> {
  const next = [...(await loadQueue(store, weddingId)), move];
  await saveQueue(store, weddingId, next);
  return next;
}

// FR-16.2: "the current plan version is cached locally." A snapshot cache, refreshed whenever the
// floor-plan screen successfully loads or syncs -- read on app start so a planner can at least
// *view* the last-known plan the instant they open the app at the venue, before any network call
// has had a chance to succeed or fail.
export interface PlanCache {
  weddingId: string;
  planVersionId: string;
  planVersion: PlanVersionDetailDTO;
  cachedAt: string;
}

export async function readCachedPlan(store: KeyValueStore, weddingId: string): Promise<PlanCache | null> {
  const raw = await store.getItem(cacheKey(weddingId));
  return raw ? (JSON.parse(raw) as PlanCache) : null;
}

export async function writeCachedPlan(store: KeyValueStore, cache: PlanCache): Promise<void> {
  await store.setItem(cacheKey(cache.weddingId), JSON.stringify(cache));
}

export type ReplayResult =
  | { outcome: "empty" }
  | { outcome: "synced"; planVersion: PlanVersionDetailDTO; replayedCount: number }
  | {
      // Stale expectedRevision: someone else's save (web planner, another device) landed first.
      // Per AC2, this must never be resolved by silently re-applying the rest of the queue on top
      // of what changed -- so replay stops here, the fresh server state is handed back, and
      // whatever's left in the queue is discarded by the caller only once the planner has seen
      // what changed (see FloorPlanScreen's conflict banner).
      outcome: "conflict";
      planVersion: PlanVersionDetailDTO;
      replayedCount: number;
      remaining: QueuedMove[];
      message: string;
    }
  | {
      // A hard-rule rejection (capacity, a must-not-sit-together pair, etc.) -- there's no fresh
      // plan version to show (nothing on the server changed), but every *later* queued move
      // captured its expectedRevision assuming this one would succeed and bump the revision by 1,
      // so that chain is now off by one. Replay stops here rather than let those moves fail too
      // (each as its own confusing "conflict"); the caller drops the rejected move, re-fetches the
      // server's actual current revision, and rebaseQueue()s the remainder onto it before retrying.
      outcome: "rejected";
      message: string;
      move: QueuedMove;
      replayedCount: number;
      remaining: QueuedMove[];
    }
  | { outcome: "offline"; replayedCount: number; remaining: QueuedMove[] };

// After dropping a rejected move (see the "rejected" outcome above), the rest of the queue's
// expectedRevision values no longer line up with the server's actual revision -- this renumbers
// them sequentially starting from a freshly-fetched baseRevision, the same way they were
// originally assigned when each move was first queued (see FloorPlanScreen).
export function rebaseQueue(queue: QueuedMove[], baseRevision: number): QueuedMove[] {
  return queue.map((move, i) => ({ ...move, expectedRevision: baseRevision + i }));
}

// Submits each queued move to the server in order, stopping at the first genuine conflict (a
// newer revision than this device knew about) or the first network failure, but skipping past --
// and continuing after -- a plain business-rule rejection. Never touches the store itself; the
// caller (FloorPlanScreen) decides what to persist based on the outcome, since a "conflict" result
// needs the planner's acknowledgement before the remaining queue is cleared.
export async function replayQueue(
  moveFn: (move: QueuedMove) => Promise<{ planVersion: PlanVersionDetailDTO }>,
  queue: QueuedMove[]
): Promise<ReplayResult> {
  if (queue.length === 0) return { outcome: "empty" };

  let replayedCount = 0;
  let lastPlanVersion: PlanVersionDetailDTO | null = null;

  for (let i = 0; i < queue.length; i++) {
    const move = queue[i];
    try {
      const res = await moveFn(move);
      lastPlanVersion = res.planVersion;
      replayedCount++;
    } catch (err) {
      if (err instanceof MoveConflictError) {
        return {
          outcome: "conflict",
          planVersion: err.planVersion,
          replayedCount,
          remaining: queue.slice(i),
          message: err.message,
        };
      }
      if (err instanceof MoveRejectedError) {
        return {
          outcome: "rejected",
          message: err.message,
          move,
          replayedCount,
          remaining: queue.slice(i + 1),
        };
      }
      if (err instanceof NetworkError) {
        return { outcome: "offline", replayedCount, remaining: queue.slice(i) };
      }
      throw err;
    }
  }

  return { outcome: "synced", planVersion: lastPlanVersion!, replayedCount };
}
