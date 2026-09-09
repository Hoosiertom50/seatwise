import { NextRequest, NextResponse } from "next/server";
import { planVersionStatusSchema } from "@seatwise/shared";
import {
  setPlanVersionStatus,
  getWeddingAccessDetail,
  PlanVersionStatusError,
  PlanVersionConflictError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

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

  const body = await req.json().catch(() => null);
  const parsed = planVersionStatusSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  if (parsed.data.status === "APPROVED" && access.accessLevel !== "OWNER") {
    const detail = await getWeddingAccessDetail(weddingId, user.id);
    const canApprove = detail.role === "COUPLE" && detail.accessLevel !== "VIEW";
    if (!canApprove) {
      return errorResponse(
        "Only the wedding's owner, or a Couple member with Comment or Edit access, can approve a plan.",
        403
      );
    }
  } else if (parsed.data.status !== "APPROVED" && access.accessLevel !== "OWNER" && access.accessLevel !== "EDIT") {
    // Draft <-> In Review still requires Edit -- only Approve gets the Couple/Comment carve-out.
    return errorResponse("You don't have permission to do that", 403);
  }

  try {
    const planVersion = await setPlanVersionStatus(
      planVersionId,
      weddingId,
      parsed.data.status,
      user.id,
      parsed.data.expectedRevision
    );
    if (!planVersion) return errorResponse("Plan version not found", 404);
    return NextResponse.json({ planVersion });
  } catch (err) {
    if (err instanceof PlanVersionConflictError) {
      return NextResponse.json(
        { error: err.message, planVersion: err.planVersion },
        { status: 409 }
      );
    }
    if (err instanceof PlanVersionStatusError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
