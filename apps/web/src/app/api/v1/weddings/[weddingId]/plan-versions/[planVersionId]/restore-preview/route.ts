import { NextRequest, NextResponse } from "next/server";
import { previewPlanVersionRestore, getCurrentPlanVersionIdAndStatus, RestoreError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess, mayManageApproval } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-9.4: a dry run of restoring this version — computes exactly what would change (kept vs.
// dropped assignments, any new warnings) against current data, without writing anything. Meant
// to back a confirmation step before the actual restore is committed. Read-only, so View access
// is enough to see it — only the actual POST /restore requires Edit.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  try {
    const preview = await previewPlanVersionRestore(planVersionId, weddingId);
    // TS-208: whether confirming will be saved as a comparison draft (the current plan is approved
    // and this person can't replace an approved plan) -- the restore route decides the same way,
    // and the preview now says so before they confirm rather than after.
    const current = access.accessLevel !== "VIEW" ? await getCurrentPlanVersionIdAndStatus(weddingId) : null;
    const currentIsApproved = current?.status === "APPROVED";
    // TS-204: from the request's one access reading (requireAccess).
    const willSaveAsDraft = currentIsApproved && !mayManageApproval(access);
    // TS-231: or, for someone who may replace it, that confirming replaces the approved plan.
    const willReplaceApproved = currentIsApproved && mayManageApproval(access);
    // TS-237: and which approved version that is -- confirming the restore sends it back, and the
    // restore is refused if a different one (or a newly approved one) is current by then.
    return NextResponse.json({
      preview,
      willSaveAsDraft,
      willReplaceApproved,
      approvedVersionId: willReplaceApproved ? current!.id : null,
    });
  } catch (err) {
    if (err instanceof RestoreError) return errorResponse(err.message, 404);
    throw err;
  }
}
