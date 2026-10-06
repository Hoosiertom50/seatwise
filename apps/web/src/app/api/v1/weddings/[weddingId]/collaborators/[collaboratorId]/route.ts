import { NextRequest, NextResponse } from "next/server";
import { updateCollaboratorSchema } from "@seatwise/shared";
import { updateCollaboratorPermission, removeCollaborator, getCollaboratorForWedding, CollaboratorError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse } from "@/lib/api-response";
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
    // TS-199: the saved level and role go back to the screen, which shows them.
    const saved = await updateCollaboratorPermission(weddingId, collaboratorId, parsed.data.permissionLevel, parsed.data.role, user.id);
    return NextResponse.json({ ok: true, collaborator: saved });
  } catch (err) {
    // TS-195: no longer the owner (handed off a moment ago) -- 403; otherwise not found.
    if (err instanceof CollaboratorError) return errorResponse(err.message, err.code === "NOT_OWNER" ? 403 : 404);
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}

// The owner removes someone; TS-148: or a collaborator removes their own access ("Leave").
export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, collaboratorId } = await params;
  const own = await getCollaboratorForWedding(weddingId, collaboratorId);
  const leaving = own?.userId === user.id;
  if (!leaving) {
    const access = await requireAccess(weddingId, user.id, "OWNER");
    if ("error" in access) return access.error;
  }

  try {
    // TS-195: who may remove whom is checked again under the wedding's lock.
    await removeCollaborator(weddingId, collaboratorId, user.id, { leaving });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CollaboratorError) {
      // TS-195: leaving while the wedding was being handed to them -- they own it now (409, said
      // so); no longer the owner -- 403.
      const status = err.code === "IS_OWNER" ? 409 : err.code === "NOT_OWNER" ? 403 : 404;
      return errorResponse(err.message, status);
    }
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
