import { NextRequest, NextResponse } from "next/server";
import { swapGuestAssignmentsSchema } from "@seatwise/shared";
import { swapGuestAssignments, SwapError, PlanVersionConflictError, PlanVersionNotFoundError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// TS-11 (Day-Of Mode, FR-8.1): swap two guests' (or their forced-together units') tables in one
// atomic move. Both directions are validated against every hard rule before anything changes —
// if either direction would break one, the whole swap is blocked with a specific explanation and
// nothing changes; an AVOID conflict in either direction is allowed but comes back as a warning.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = swapGuestAssignmentsSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const { planVersion, warnings } = await swapGuestAssignments(
      planVersionId,
      weddingId,
      parsed.data.guestAId,
      parsed.data.guestBId,
      user.id,
      parsed.data.expectedRevision
    );
    return NextResponse.json({ planVersion, warnings });
  } catch (err) {
    if (err instanceof PlanVersionNotFoundError) return errorResponse(err.message, 404);
    if (err instanceof PlanVersionConflictError) {
      return NextResponse.json(
        { error: err.message, planVersion: err.planVersion },
        { status: 409 }
      );
    }
    if (err instanceof SwapError) {
      // TS-197: see the assignments route -- a newer plan comes back with the refusal.
      if (err.planVersion) return NextResponse.json({ error: err.message, planVersion: err.planVersion }, { status: 409 });
      return errorResponse(err.message, 409);
    }
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
