import { NextRequest, NextResponse } from "next/server";
import { updateTimelineEntrySchema } from "@seatwise/shared";
import { getTimelineEntryForWedding, updateTimelineEntry, deleteTimelineEntry } from "@seatwise/db";
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

  const entry = await updateTimelineEntry(entryId, weddingId, parsed.data);
  if (!entry) return errorResponse("Timeline entry not found", 404);
  return NextResponse.json({ entry });
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
