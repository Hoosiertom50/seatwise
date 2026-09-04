import { NextRequest, NextResponse } from "next/server";
import { restorePlanVersion, RestoreError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// FR-9.4: commit a restore — copies this version's assignments into a brand-new version
// (re-validated against current data; anything now invalid is dropped to Unassigned with a
// warning) that becomes Current simply by being the newest version. The source version and
// everything in between are never touched. The client is expected to have already shown the
// user the /restore-preview result and gotten their confirmation before calling this.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  try {
    const { planVersion, warnings } = await restorePlanVersion(planVersionId, weddingId, user.id);
    return NextResponse.json({ planVersion, warnings }, { status: 201 });
  } catch (err) {
    if (err instanceof RestoreError) return errorResponse(err.message, 404);
    throw err;
  }
}
