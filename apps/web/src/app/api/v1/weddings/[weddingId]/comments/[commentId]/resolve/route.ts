import { NextRequest, NextResponse } from "next/server";
import { resolveComment, CommentError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, weddingDeletedResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; commentId: string }> };

// FR-10.3: only the original commenter or someone with Edit access can resolve a thread — the
// query layer enforces the "original commenter OR editor" rule itself, this route just needs to
// establish that the requester has at least Comment access to be here at all, and tells the
// query layer whether they separately qualify as an editor.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, commentId } = await params;
  const access = await requireAccess(weddingId, user.id, "COMMENT");
  if ("error" in access) return access.error;

  const canEdit = access.accessLevel === "OWNER" || access.accessLevel === "EDIT";

  try {
    const comment = await resolveComment(weddingId, commentId, user.id, canEdit, access.actor);
    return NextResponse.json({ ok: true, comment });
  } catch (err) {
    if (err instanceof CommentError) {
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : 403);
    }
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    const refused = weddingDeletedResponse(err);
    if (refused) return refused;
    throw err;
  }
}
