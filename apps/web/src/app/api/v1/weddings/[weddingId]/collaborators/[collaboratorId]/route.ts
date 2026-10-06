import { NextRequest, NextResponse } from "next/server";
import { updateCollaboratorSchema } from "@seatwise/shared";
import { updateCollaboratorPermission, removeCollaborator, getCollaboratorForWedding, CollaboratorError } from "@seatwise/db";
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
    // TS-195: the saved level and role go back to the screen, which shows them.
    const saved = await updateCollaboratorPermission(weddingId, collaboratorId, parsed.data.permissionLevel, parsed.data.role);
    return NextResponse.json({ ok: true, collaborator: saved });
  } catch (err) {
    if (err instanceof CollaboratorError) return errorResponse(err.message, 404);
    throw err;
  }
}

// The owner removes someone; TS-148: or a collaborator removes their own access ("Leave").
export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, collaboratorId } = await params;
  const own = await getCollaboratorForWedding(weddingId, collaboratorId);
  if (own?.userId !== user.id) {
    const access = await requireAccess(weddingId, user.id, "OWNER");
    if ("error" in access) return access.error;
  }

  try {
    await removeCollaborator(weddingId, collaboratorId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CollaboratorError) return errorResponse(err.message, 404);
    throw err;
  }
}
