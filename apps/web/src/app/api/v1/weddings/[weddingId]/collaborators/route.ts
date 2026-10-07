import { NextRequest, NextResponse } from "next/server";
import { addCollaboratorSchema } from "@seatwise/shared";
import { listCollaboratorsForWedding, addCollaborator, CollaboratorError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { directCollaboratorAddAllowed } from "@/lib/direct-add";

type Params = { params: Promise<{ weddingId: string }> };

// TS-13 (Collaboration & Notifications, FR-10.x): viewing who has access is available to anyone
// with access; managing collaborators (inviting/removing/changing level) is owner-only.
// NOTE: this POST directly grants access to an already-registered account -- no invite/acceptance
// step. TS-148: it exists only as test/setup scaffolding, so the live site refuses it: real people
// only get access by accepting an invite (FR-1.4a), never by being added without saying yes.
// Allowed in local development, and in CI where ALLOW_DIRECT_COLLABORATOR_ADD=1 is set.

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  // TS-148: only the owner sees everyone's email address; others see their own.
  const collaborators = (await listCollaboratorsForWedding(weddingId)).map((c) =>
    access.accessLevel === "OWNER" || c.userId === user.id ? c : { ...c, userEmail: null }
  );
  return NextResponse.json({ collaborators });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  if (!directCollaboratorAddAllowed(process.env)) return errorResponse("Invite people from the Collaborators tab instead.", 404);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
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
