import { NextRequest, NextResponse } from "next/server";
import { resetWeddingLinkTokens, LinkResetNotOwnerError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, concurrentChangeResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-179 (Tom's decision): the owner's "Reset all guest and vendor links". Every guest RSVP link and
// vendor share link this wedding has handed out is replaced, so the old ones stop working -- for
// when someone who copied links (say, a removed collaborator) shouldn't be able to use them any
// more. Owner only. Nothing is emailed: the planner shares the new links from the guest list and
// the budget tab. Returns how many links were replaced.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  try {
    const result = await resetWeddingLinkTokens(weddingId, user.id);
    return NextResponse.json(result);
  } catch (err) {
    // TS-195: handed off to someone else a moment ago -- the owner check is made again under the
    // wedding's lock.
    if (err instanceof LinkResetNotOwnerError) return errorResponse(err.message, 403);
    // TS-195: lost a race with another change, or the wedding was deleted (nothing saved) -- a
    // clear 409/404, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
