import { NextRequest, NextResponse } from "next/server";
import { listActivityForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// FR-10.1: a single chronological activity log across every plan version of the wedding.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const entries = await listActivityForWedding(weddingId);
  return NextResponse.json({ entries });
}
