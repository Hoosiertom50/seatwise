import { NextRequest, NextResponse } from "next/server";
import { moveGuestAssignmentSchema } from "@seatwise/shared";
import { getWeddingForOwner, moveGuestAssignment, ManualMoveError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// TS-10 (Manual Adjustment): move a guest to a different table within the Current Plan
// Version. FR-7.2's hard-rule check (capacity, must-sit/must-not-sit-together, requires an
// accessible table) blocks the move outright with a specific explanation and changes nothing;
// FR-7.3's soft-rule (avoid) conflicts are allowed and come back as warnings. FR-7.6: every
// successful move is recorded as a change-history entry, not a new plan version.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  const body = await req.json().catch(() => null);
  const parsed = moveGuestAssignmentSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const { planVersion, warnings } = await moveGuestAssignment(
      planVersionId,
      weddingId,
      parsed.data.guestId,
      parsed.data.tableId,
      user.id
    );
    return NextResponse.json({ planVersion, warnings });
  } catch (err) {
    if (err instanceof ManualMoveError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
