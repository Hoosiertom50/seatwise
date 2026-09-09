import type { PlanVersionDetailDTO } from "@seatwise/shared";
import type { ApiClient } from "./client";
import { ApiError } from "./client";

// Mirrors the two distinct 409 shapes the assignments endpoint returns (see
// apps/web/src/app/api/v1/weddings/[weddingId]/plan-versions/[planVersionId]/assignments/route.ts):
// a stale expectedRevision (someone else's save landed first -- the fresh plan version rides
// along) vs. a hard-rule rejection (a genuinely invalid move -- nothing to refresh from, retrying
// with a newer revision wouldn't help). The offline replay queue treats these very differently:
// a conflict stops the queue and asks the planner to look at what changed; a rejection just
// drops that one move and keeps going.
export class MoveConflictError extends Error {
  planVersion: PlanVersionDetailDTO;
  constructor(message: string, planVersion: PlanVersionDetailDTO) {
    super(message);
    this.name = "MoveConflictError";
    this.planVersion = planVersion;
  }
}

export class MoveRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveRejectedError";
  }
}

export interface MoveResponse {
  planVersion: PlanVersionDetailDTO;
  warnings: string[];
}

// FR-16.1: the exact same endpoint (and hard/soft-rule validation) the web app's Plan tab already
// calls for a manual move -- see PlanTab.tsx's conflictPlanVersion helper for the web-side
// equivalent of the error handling below. tableId: null moves a guest back to Unassigned.
export async function moveGuest(
  api: ApiClient,
  weddingId: string,
  planVersionId: string,
  guestId: string,
  tableId: string | null,
  expectedRevision: number
): Promise<MoveResponse> {
  try {
    return await api.post<MoveResponse>(
      `/api/v1/weddings/${weddingId}/plan-versions/${planVersionId}/assignments`,
      { guestId, tableId, expectedRevision }
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if (err.data?.planVersion) {
        throw new MoveConflictError(err.data.error ?? "This plan changed elsewhere", err.data.planVersion);
      }
      throw new MoveRejectedError(err.data?.error ?? "That move isn't allowed");
    }
    throw err;
  }
}
