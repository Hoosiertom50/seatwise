import { NextRequest, NextResponse } from "next/server";
import { comparePlanVersions, CompareVersionError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-10/TS-12: side-by-side comparison of two plan versions, guest by guest.
// GET .../plan-versions/compare?from=<versionId>&to=<versionId>
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const fromId = req.nextUrl.searchParams.get("from");
  const toId = req.nextUrl.searchParams.get("to");
  if (!fromId || !toId) {
    return errorResponse("Both 'from' and 'to' plan version IDs are required.", 422);
  }

  try {
    const comparison = await comparePlanVersions(weddingId, fromId, toId);
    return NextResponse.json({ comparison });
  } catch (err) {
    if (err instanceof CompareVersionError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
