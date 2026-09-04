import { NextRequest, NextResponse } from "next/server";
import { createRelationshipSchema } from "@seatwise/shared";
import {
  getGuestForWedding,
  createRelationship,
  listRelationshipsForWedding,
  RelationshipConflictError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const relationships = await listRelationshipsForWedding(weddingId);
  return NextResponse.json({ relationships });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = createRelationshipSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // Both guests must actually belong to this wedding — otherwise a caller could link a guest
  // from a different wedding they don't even have access to.
  const [guestA, guestB] = await Promise.all([
    getGuestForWedding(parsed.data.guestAId, weddingId),
    getGuestForWedding(parsed.data.guestBId, weddingId),
  ]);
  if (!guestA || !guestB) return errorResponse("Both guests must belong to this wedding", 404);

  try {
    const relationship = await createRelationship(weddingId, parsed.data);
    return NextResponse.json({ relationship }, { status: 201 });
  } catch (err) {
    if (err instanceof RelationshipConflictError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
