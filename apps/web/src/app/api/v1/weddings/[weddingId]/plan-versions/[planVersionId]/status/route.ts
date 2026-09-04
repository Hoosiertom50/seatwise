import { NextRequest, NextResponse } from "next/server";
import { planVersionStatusSchema } from "@seatwise/shared";
import { getWeddingForOwner, setPlanVersionStatus, PlanVersionStatusError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-6.4: move a plan version's review status (Draft / In Review / Approved). Today the only
// account type is a wedding's owner, so "any Edit user can move Draft<->In Review, only the
// Planner/Owner or a Couple user with Comment/Edit can Approve" collapses to "the owner can do
// either" — there's no collaborator/permission-level model yet (that's a separate, substantial
// piece of TS-9 — sharing, in-app notifications, and per-user View/Comment/Edit access — not
// built in this pass). Approving still requires a complete plan (FR-0.1) and only ever applies
// to the Current version.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  const body = await req.json().catch(() => null);
  const parsed = planVersionStatusSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const planVersion = await setPlanVersionStatus(
      planVersionId,
      weddingId,
      parsed.data.status,
      user.id
    );
    if (!planVersion) return errorResponse("Plan version not found", 404);
    return NextResponse.json({ planVersion });
  } catch (err) {
    if (err instanceof PlanVersionStatusError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
