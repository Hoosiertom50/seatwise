import { NextRequest, NextResponse } from "next/server";
import { addTemplateTablesSchema } from "@seatwise/shared";
import { addTemplateTablesToWedding, listSeatingTablesForWedding, TemplateNotFoundError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse, readJson } from "@/lib/api-response";
import { SAVED_BUT_NOT_REFRESHED, afterSave } from "@/lib/post-save";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-91: adds a saved template's tables to this (already existing) wedding -- previously a
// template could only be applied when a wedding was first created. Additive only: nothing already
// in the wedding is changed or removed. Needs Edit access here, and the template must be yours.
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
  const parsed = addTemplateTablesSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  let addedCount: number;
  try {
    addedCount = await addTemplateTablesToWedding(weddingId, parsed.data.templateId, user.id, access.actor);
  } catch (err) {
    if (err instanceof TemplateNotFoundError) return errorResponse("Template not found", 404);
    // TS-195: the wedding was deleted while this was being saved -- 404, not a server error.
    // TS-209: and the database being too busy (nothing saved) -- see concurrentChangeResponse.
    const handled = concurrentChangeResponse(err);
    if (handled) return handled;
    throw err;
  }
  // TS-209: the tables are added -- reading the list back can't turn that into an error. Without
  // the list (null), the screen keeps its own until it next refreshes.
  const warnings: string[] = [];
  const tables = await afterSave("reading the tables back", () => listSeatingTablesForWedding(weddingId), warnings, SAVED_BUT_NOT_REFRESHED, null);
  return NextResponse.json({ addedCount, tables, warnings }, { status: 201 });
}
