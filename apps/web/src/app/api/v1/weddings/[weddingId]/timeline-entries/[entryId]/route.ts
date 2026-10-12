import { NextRequest, NextResponse } from "next/server";
import { updateTimelineEntrySchema } from "@seatwise/shared";
import { getTimelineEntryForWedding, updateTimelineEntry, deleteTimelineEntry, TimelineConflictError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson, weddingDeletedResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { timelineChangeRefusedResponse } from "@/lib/timeline-answers";

type Params = { params: Promise<{ weddingId: string; entryId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, entryId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = updateTimelineEntrySchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { expectedRevision, ...changes } = parsed.data;
  try {
    const entry = await updateTimelineEntry(entryId, weddingId, changes, expectedRevision, access.actor);
    if (!entry) return errorResponse("Timeline entry not found", 404);
    return NextResponse.json({ entry });
  } catch (err) {
    // TS-92: stale save -- refused, with the fresh entry so the UI can show the latest.
    if (err instanceof TimelineConflictError) {
      return NextResponse.json({ error: err.message, entry: err.entry }, { status: 409 });
    }
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    // TS-234: and a lost race (409) or a too-busy database (503), not a server error.
    const refused = timelineChangeRefusedResponse(err);
    if (refused) return refused;
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

  let deleted: boolean;
  try {
    deleted = await deleteTimelineEntry(entryId, weddingId, access.actor);
  } catch (err) {
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    const refused = weddingDeletedResponse(err);
    if (refused) return refused;
    throw err;
  }
  if (!deleted) return errorResponse("Timeline entry not found", 404);
  return NextResponse.json({ ok: true });
}
