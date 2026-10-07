import { NextRequest, NextResponse } from "next/server";
import { getPlanVersionDetail, setPlanVersionLabel, PlanVersionConflictError, PlanVersionNotFoundError } from "@seatwise/db";
import { setPlanVersionLabelSchema } from "@seatwise/shared";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) return errorResponse("Plan version not found", 404);

  return NextResponse.json({ planVersion });
}

// TS-10/TS-12: rename/relabel a plan version so it's easier to tell apart than just its version
// number ("Family-approved draft", "Post-RSVP final"). Any collaborator who can edit the plan
// may relabel any version, current or not — a label is just a memory aid.
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = setPlanVersionLabelSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const planVersion = await setPlanVersionLabel(
      planVersionId,
      weddingId,
      parsed.data.label,
      parsed.data.expectedRevision,
      // TS-204: read again under the plan's lock.
      access.actor
    );
    if (!planVersion) return errorResponse("Plan version not found", 404);
    return NextResponse.json({ planVersion });
  } catch (err) {
    if (err instanceof PlanVersionNotFoundError) return errorResponse(err.message, 404);
    if (err instanceof PlanVersionConflictError) {
      return NextResponse.json(
        { error: err.message, planVersion: err.planVersion },
        { status: 409 }
      );
    }
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
