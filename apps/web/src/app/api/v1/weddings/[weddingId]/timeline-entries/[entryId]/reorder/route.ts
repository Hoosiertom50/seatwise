import { NextRequest, NextResponse } from "next/server";
import { reorderTimelineEntrySchema } from "@seatwise/shared";
import { reorderTimelineEntry } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; entryId: string }> };

// FR-13.2: moves this entry earlier/later among any other entries sharing its exact same `time`
// -- a no-op (200, entry unchanged) if it's already first/last within that tied group.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, entryId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = reorderTimelineEntrySchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const entry = await reorderTimelineEntry(entryId, weddingId, parsed.data.direction);
  if (!entry) return errorResponse("Timeline entry not found", 404);
  return NextResponse.json({ entry });
}
