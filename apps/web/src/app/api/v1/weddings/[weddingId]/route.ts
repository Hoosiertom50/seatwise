import { NextRequest, NextResponse } from "next/server";
import { updateWeddingSchema } from "@seatwise/shared";
import { getWeddingById, updateWeddingForOwner, deleteWeddingForOwner } from "@seatwise/db";
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

  return NextResponse.json({ wedding: access.wedding, accessLevel: access.accessLevel });
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

  await updateWeddingForOwner(weddingId, user.id, parsed.data);
  const wedding = await getWeddingById(weddingId);
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
