import { NextRequest, NextResponse } from "next/server";
import { deleteRelationshipForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; relationshipId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, relationshipId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const deleted = await deleteRelationshipForWedding(relationshipId, weddingId);
  if (!deleted) return errorResponse("Rule not found", 404);

  return NextResponse.json({ ok: true });
}
