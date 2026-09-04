import { NextRequest, NextResponse } from "next/server";
import { getWeddingForOwner, deleteRelationshipForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ weddingId: string; relationshipId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, relationshipId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  const deleted = await deleteRelationshipForWedding(relationshipId, weddingId);
  if (!deleted) return errorResponse("Rule not found", 404);

  return NextResponse.json({ ok: true });
}
