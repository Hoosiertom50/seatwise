import { NextRequest, NextResponse } from "next/server";
import { updateWeddingSchema, sideLabelsClash, SIDE_LABELS_MESSAGE } from "@seatwise/shared";
import { getWeddingById, updateWeddingForOwner, deleteWeddingForOwner, getWeddingAccessDetail } from "@seatwise/db";
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

  // TS-151: the caller's collaborator role too (null for the owner), so the page can offer Approve
  // to a Couple member with Comment access -- the server already allows it.
  const { role } = await getWeddingAccessDetail(weddingId, user.id);
  return NextResponse.json({ wedding: access.wedding, accessLevel: access.accessLevel, role });
}

// Renaming/rescheduling the wedding is owner-only — collaborators (even Edit) can't touch these
// top-level settings.
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = updateWeddingSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);
  // TS-190: a side name saved on its own must still differ from the other, stored one.
  const { sideLabel1, sideLabel2 } = parsed.data;
  if (
    (sideLabel1 !== undefined || sideLabel2 !== undefined) &&
    sideLabelsClash(sideLabel1 ?? access.wedding.sideLabel1, sideLabel2 ?? access.wedding.sideLabel2)
  ) {
    return errorResponse(SIDE_LABELS_MESSAGE, 422, { [sideLabel1 !== undefined ? "sideLabel1" : "sideLabel2"]: [SIDE_LABELS_MESSAGE] });
  }

  const saved = await updateWeddingForOwner(weddingId, user.id, parsed.data);
  // TS-195: the other side was renamed to this same name a moment ago (another tab) -- checked
  // again as it saves; nothing was saved.
  if (saved === "SIDE_LABELS_CLASH") {
    return errorResponse(SIDE_LABELS_MESSAGE, 422, { [sideLabel1 !== undefined ? "sideLabel1" : "sideLabel2"]: [SIDE_LABELS_MESSAGE] });
  }
  const wedding = await getWeddingById(weddingId);
  // TS-195: deleted, or handed to someone else, a moment ago -- nothing was saved (it used to answer
  // as if it had been).
  if (saved === "NOT_FOUND") {
    return wedding
      ? errorResponse("Only the wedding's owner can change these settings — you aren't its owner any more.", 403)
      : errorResponse("Wedding not found", 404);
  }
  return NextResponse.json({ wedding });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const deleted = await deleteWeddingForOwner(weddingId, user.id);
  if (!deleted) return errorResponse("Wedding not found", 404);

  return NextResponse.json({ ok: true });
}
