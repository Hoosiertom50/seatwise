import { NextRequest, NextResponse } from "next/server";
import { createTimelineEntrySchema } from "@seatwise/shared";
import { createTimelineEntry, listTimelineEntriesForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-18 (FR-13.1/FR-13.2): the day-of timeline is its own record -- View/Comment/Edit access
// follows the exact same per-wedding rules as every other tab (FR-13.3), nothing guest/table/rule
// specific is checked here at all.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const entries = await listTimelineEntriesForWedding(weddingId);
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = createTimelineEntrySchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const entry = await createTimelineEntry(weddingId, parsed.data);
  return NextResponse.json({ entry }, { status: 201 });
}
