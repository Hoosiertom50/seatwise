import { NextRequest, NextResponse } from "next/server";
import { resetWeddingLinkTokens } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
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

  const result = await resetWeddingLinkTokens(weddingId);
  return NextResponse.json(result);
}
