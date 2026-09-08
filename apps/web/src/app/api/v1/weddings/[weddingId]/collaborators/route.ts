import { NextRequest, NextResponse } from "next/server";
import { addCollaboratorSchema } from "@seatwise/shared";
import { listCollaboratorsForWedding, addCollaborator, CollaboratorError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-13 (Collaboration & Notifications, FR-10.x): viewing who has access is available to anyone
// with access; managing collaborators (inviting/removing/changing level) is owner-only.
// NOTE: this POST directly grants access to an already-registered account -- no invite/acceptance
// step -- and is used mainly as fast test/setup scaffolding; the Collaborators tab's user-facing
// "Invite a collaborator" action goes through /invites instead (FR-1.4a).
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const collaborators = await listCollaboratorsForWedding(weddingId);
  return NextResponse.json({ collaborators });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = addCollaboratorSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const collaborator = await addCollaborator(
      weddingId,
      user.id,
      parsed.data.email,
      parsed.data.permissionLevel,
      parsed.data.role
    );
    return NextResponse.json({ collaborator }, { status: 201 });
  } catch (err) {
    if (err instanceof CollaboratorError) {
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : 409);
    }
    throw err;
  }
}
