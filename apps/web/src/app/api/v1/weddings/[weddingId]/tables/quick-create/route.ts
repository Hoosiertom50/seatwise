import { NextRequest, NextResponse } from "next/server";
import { quickCreateTablesSchema } from "@seatwise/shared";
import { quickCreateSeatingTables } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, weddingDeletedResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// FR-4.2: create a standard set of tables (e.g. "12 round tables of 8") in one action.
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
  const parsed = quickCreateTablesSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const tables = await quickCreateSeatingTables(weddingId, parsed.data, access.actor);
    return NextResponse.json({ tables }, { status: 201 });
  } catch (err) {
    // TS-195: the wedding was deleted while this was being saved -- 404, not a server error.
    const gone = weddingDeletedResponse(err);
    if (gone) return gone;
    throw err;
  }
}
