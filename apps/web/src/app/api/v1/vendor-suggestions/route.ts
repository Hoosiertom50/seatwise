import { NextRequest, NextResponse } from "next/server";
import { listVendorSuggestionsForOwner } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

// TS-97: vendors from the planner's own other weddings, for "Add a vendor" to suggest. Like
// templates, this is portfolio-level: gated only by who's asking, and it only ever reads weddings
// that person owns. `?excludeWeddingId=` leaves out the wedding being added to (its vendors are
// already on it).
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const exclude = req.nextUrl.searchParams.get("excludeWeddingId");
  const suggestions = await listVendorSuggestionsForOwner(user.id, exclude || null);
  return NextResponse.json({ suggestions });
}
