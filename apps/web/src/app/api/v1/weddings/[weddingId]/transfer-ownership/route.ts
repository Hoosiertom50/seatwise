import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { notifyWeddingCollaborators, transferWeddingOwnership, OwnershipTransferError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

const bodySchema = z.object({ collaboratorId: z.string().min(1, "Pick who to hand this wedding to") });

// TS-105: the owner hands the wedding to one of its existing collaborators, who becomes the owner.
// The previous owner stays on with Edit access (and can leave afterwards).
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const result = await transferWeddingOwnership(weddingId, user.id, parsed.data.collaboratorId);
    // TS-213 (Tom's decision): the new owner is told -- in the app, and by email unless they've
    // turned this wedding's emails off. Best effort: the hand-off is already saved.
    await notifyWeddingCollaborators(
      weddingId,
      user.id,
      "OWNERSHIP_TRANSFERRED",
      `${user.name} handed "${access.wedding.name}" to you — you're now its owner.`,
      {
        onlyUserIds: [result.newOwnerUserId],
        emailMessage: "A wedding has been handed to you on Seatwise — you're now its owner. Open Seatwise to see it.",
      }
    );
    return NextResponse.json({ ok: true, newOwnerName: result.newOwnerName });
  } catch (err) {
    if (err instanceof OwnershipTransferError) return errorResponse(err.message, 409);
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
