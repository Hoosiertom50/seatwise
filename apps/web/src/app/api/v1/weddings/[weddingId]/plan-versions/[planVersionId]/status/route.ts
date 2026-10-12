import { NextRequest, NextResponse } from "next/server";
import { planVersionStatusSchema } from "@seatwise/shared";
import {
  setPlanVersionStatus,
  PlanVersionStatusError,
  PlanApprovalPermissionError,
  PlanVersionConflictError,
  PlanVersionNotFoundError,
  getPlanVersionStatusForWedding,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse, readJson } from "@/lib/api-response";
import { requireAccess, mayManageApproval as mayManageApprovalFor, approvalActor } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-6.4: move a plan version's review status (Draft / In Review / Approved). Any Edit-level user
// can move Draft<->In Review; approving is narrower -- only the wedding's owner, or a Couple-role
// collaborator with at least Comment permission, may Approve. Note this makes Approve reachable by
// someone who *doesn't* otherwise have Edit access (a Couple member at Comment-only), so the base
// access check here is COMMENT, not EDIT -- Draft<->In Review is then re-gated to EDIT below.
// Approving still requires a complete plan (FR-0.1) and only ever applies to the Current version.
// A status change fires the FR-10.2 notification: moving to In Review is "the plan was shared for
// review," any other transition is a plain status change.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "COMMENT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = planVersionStatusSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-172 (Tom's decision, 2026-10-05): undoing an approval (Approved -> Draft or In review) is for
  // the same people who can approve -- before, any Edit collaborator could withdraw it.
  // TS-179: these are also passed to setPlanVersionStatus, which checks them again under the lock
  // against the plan's real status -- the read below is only for a quick, friendly refusal.
  // TS-204: from the same access reading the change re-checks under its lock (not read again).
  const mayManageApproval = mayManageApprovalFor(access);
  const mayMoveDraftAndReview = access.accessLevel === "OWNER" || access.accessLevel === "EDIT";
  // TS-189: a request that names the copy it was made from (expectedRevision) is judged entirely
  // under the plan's lock, stale copy first -- so someone acting on a plan that changed since they
  // loaded it is shown the plan as it is now, not refused over a status they haven't seen yet. And
  // someone who can undo an approval but not otherwise move a plan between Draft and In review is
  // also left to that check (it tells them the approval was already undone).
  // TS-197: whether the person asking saw this plan approved. With expectedRevision, the plan's
  // status is checked under its lock against the copy they had (a changed copy is refused as stale
  // first), so what they saw is what is there -- not approved, if it gets that far. Without it, it's
  // what was read just below.
  let sawApproved = false;
  if (parsed.data.expectedRevision === undefined) {
    const currentStatus = await getPlanVersionStatusForWedding(planVersionId, weddingId);
    sawApproved = currentStatus === "APPROVED";
    const touchesApproval = parsed.data.status === "APPROVED" || currentStatus === "APPROVED";
    if (touchesApproval) {
      if (!mayManageApproval) {
        return errorResponse(
          parsed.data.status === "APPROVED"
            ? "Only the wedding's owner, or a Couple member with Comment or Edit access, can approve a plan."
            : "Only the wedding's owner, or a Couple member with Comment or Edit access, can undo an approval.",
          403
        );
      }
    } else if (!mayMoveDraftAndReview && !mayManageApproval) {
      // Draft <-> In Review still requires Edit -- only Approve gets the Couple/Comment carve-out.
      return errorResponse("You don't have permission to do that", 403);
    }
  }

  try {
    const planVersion = await setPlanVersionStatus(
      planVersionId,
      weddingId,
      parsed.data.status,
      user.id,
      parsed.data.expectedRevision,
      {
        mayApprove: mayManageApproval,
        mayLeaveApproved: mayManageApproval,
        mayMoveDraftAndReview,
        sawApproved,
        // TS-195: what these were worked out from, read again under the plan's lock.
        judgedAccess: approvalActor(access),
      }
    );
    if (!planVersion) return errorResponse("Plan version not found", 404);
    return NextResponse.json({ planVersion });
  } catch (err) {
    if (err instanceof PlanVersionNotFoundError) return errorResponse(err.message, 404);
    if (err instanceof PlanApprovalPermissionError) return errorResponse(err.message, 403);
    if (err instanceof PlanVersionConflictError) {
      return NextResponse.json(
        { error: err.message, planVersion: err.planVersion },
        { status: 409 }
      );
    }
    if (err instanceof PlanVersionStatusError) {
      // TS-197: "can't be approved yet" carries the plan as it is now (re-checked, maybe a new revision).
      if (err.planVersion) return NextResponse.json({ error: err.message, planVersion: err.planVersion }, { status: 409 });
      return errorResponse(err.message, 409);
    }
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
