import { NextRequest, NextResponse } from "next/server";
import { updateCollaboratorSchema } from "@seatwise/shared";
import { updateCollaboratorPermission, removeCollaborator, CollaboratorError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; collaboratorId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, collaboratorId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = updateCollaboratorSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    await updateCollaboratorPermission(weddingId, collaboratorId, parsed.data.permissionLevel);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CollaboratorError) return errorResponse(err.message, 404);
    throw err;
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, collaboratorId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  try {
    await removeCollaborator(weddingId, collaboratorId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CollaboratorError) return errorResponse(err.message, 404);
    throw err;
  }
}
