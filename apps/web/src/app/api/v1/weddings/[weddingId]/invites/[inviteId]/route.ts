import { NextRequest, NextResponse } from "next/server";
import { revokeInvite, InviteError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; inviteId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, inviteId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  try {
    await revokeInvite(weddingId, inviteId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InviteError) return errorResponse(err.message, 404);
    throw err;
  }
}
