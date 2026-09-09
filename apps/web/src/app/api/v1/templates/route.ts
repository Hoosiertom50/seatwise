import { NextRequest, NextResponse } from "next/server";
import { listTemplatesForOwner } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

// TS-19 (FR-14.x): templates are a portfolio-level, cross-wedding asset -- gated only by the
// requesting user's own ownership, never by a per-wedding access check (a planner never sees
// another planner's templates, and there's no wedding to check access against here at all).
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const templates = await listTemplatesForOwner(user.id);
  return NextResponse.json({ templates });
}
