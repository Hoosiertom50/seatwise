import { NextRequest, NextResponse } from "next/server";
import { updateTimelineEntrySchema } from "@seatwise/shared";
import { getTimelineEntryForWedding, updateTimelineEntry, deleteTimelineEntry, TimelineConflictError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; entryId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, entryId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = updateTimelineEntrySchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { expectedRevision, ...changes } = parsed.data;
  try {
    const entry = await updateTimelineEntry(entryId, weddingId, changes, expectedRevision);
    if (!entry) return errorResponse("Timeline entry not found", 404);
    return NextResponse.json({ entry });
  } catch (err) {
    // TS-92: stale save -- refused, with the fresh entry so the UI can show the latest.
    if (err instanceof TimelineConflictError) {
      return NextResponse.json({ error: err.message, entry: err.entry }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, entryId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const existing = await getTimelineEntryForWedding(entryId, weddingId);
  if (!existing) return errorResponse("Timeline entry not found", 404);

  const deleted = await deleteTimelineEntry(entryId, weddingId);
  if (!deleted) return errorResponse("Timeline entry not found", 404);
  return NextResponse.json({ ok: true });
}
