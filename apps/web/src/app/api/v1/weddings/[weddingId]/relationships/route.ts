import { NextRequest, NextResponse } from "next/server";
import { createRelationshipSchema } from "@seatwise/shared";
import {
  resyncGuestsSeats,
  getGuestForWedding,
  createRelationship,
  listRelationshipsForWedding,
  RelationshipConflictError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { SAVED_BUT_NOT_RECHECKED } from "@/lib/post-save";

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
    // TS-150: a new rule is checked against how people are seated right now -- two guests who
    // must not sit together but already do (or must, but don't) are flagged Needs Reassignment.
    // TS-177: the rule is saved by now -- a failed re-check mustn't make it look unsaved.
    let warnings: string[];
    try {
      const { newlyFlagged } = await resyncGuestsSeats(weddingId, [parsed.data.guestAId, parsed.data.guestBId]);
      warnings = newlyFlagged.map((f) => `${f.name}'s current seat breaks this rule — flagged as Needs Reassignment.`);
    } catch (resyncErr) {
      console.error("Seating rule saved, but re-checking seats failed", resyncErr);
      warnings = [SAVED_BUT_NOT_RECHECKED];
    }
    return NextResponse.json({ relationship, warnings }, { status: 201 });
  } catch (err) {
    if (err instanceof RelationshipConflictError) {
      return errorResponse(err.message, 409);
    }
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
