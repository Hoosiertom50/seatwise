import { NextRequest, NextResponse } from "next/server";
import { deleteRelationshipForWedding, resyncGuestsSeats } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { SAVED_BUT_NOT_RECHECKED } from "@/lib/post-save";

type Params = { params: Promise<{ weddingId: string; relationshipId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, relationshipId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const deleted = await deleteRelationshipForWedding(relationshipId, weddingId);
  if (!deleted) return errorResponse("Rule not found", 404);

  // TS-150: anyone flagged only because of this rule is cleared.
  // TS-187: the rule is removed by now -- if the re-check loses a race with another change (or
  // fails), say the removal is saved but the plan wasn't re-checked, rather than a server error.
  try {
    await resyncGuestsSeats(weddingId, [deleted.guestAId, deleted.guestBId]);
  } catch (err) {
    console.error("Seating rule removed, but re-checking seats failed", err);
    return NextResponse.json({ ok: true, warnings: [SAVED_BUT_NOT_RECHECKED] });
  }
  return NextResponse.json({ ok: true });
}
