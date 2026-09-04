import { NextRequest, NextResponse } from "next/server";
import { previewPlanVersionRestore, RestoreError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

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
    return NextResponse.json({ preview });
  } catch (err) {
    if (err instanceof RestoreError) return errorResponse(err.message, 404);
    throw err;
  }
}
