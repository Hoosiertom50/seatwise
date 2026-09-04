import { NextRequest, NextResponse } from "next/server";
import { createCommentSchema } from "@seatwise/shared";
import { listCommentsForWedding, createComment, CommentError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-13 (Collaboration & Notifications, FR-10.3): comments on a guest or table. Reading requires
// View; adding a comment requires Comment-level access or better (Edit implies Comment).
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const comments = await listCommentsForWedding(weddingId);
  return NextResponse.json({ comments });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "COMMENT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = createCommentSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const comment = await createComment(weddingId, user.id, parsed.data);
    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    if (err instanceof CommentError) {
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : 422);
    }
    throw err;
  }
}
