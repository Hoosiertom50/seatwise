import { NextRequest, NextResponse } from "next/server";
import { createTimelineEntrySchema } from "@seatwise/shared";
import { createTimelineEntry, listTimelineEntriesForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, weddingDeletedResponse, readJson } from "@/lib/api-response";
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

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = createTimelineEntrySchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const entry = await createTimelineEntry(weddingId, parsed.data);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    // TS-195: the wedding was deleted while this was being saved -- 404, not a server error.
    const gone = weddingDeletedResponse(err);
    if (gone) return gone;
    throw err;
  }
}
