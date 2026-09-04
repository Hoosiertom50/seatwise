import { NextRequest, NextResponse } from "next/server";
import { getWeddingForOwner, getPlanVersionDetail } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) return errorResponse("Plan version not found", 404);

  return NextResponse.json({ planVersion });
}
