import { NextRequest, NextResponse } from "next/server";
import { planVersionStatusSchema } from "@seatwise/shared";
import {
  setPlanVersionStatus,
  PlanVersionStatusError,
  PlanVersionConflictError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-6.4: move a plan version's review status (Draft / In Review / Approved). TS-13 added a real
// View/Comment/Edit collaborator model — any Edit-level user (owner or collaborator) can move the
// status either direction; approving still requires a complete plan (FR-0.1) and only ever
// applies to the Current version. A status change fires the FR-10.2 notification: moving to
// In Review is "the plan was shared for review," any other transition is a plain status change.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = planVersionStatusSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

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
