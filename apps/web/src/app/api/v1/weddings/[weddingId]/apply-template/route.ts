import { NextRequest, NextResponse } from "next/server";
import { addTemplateTablesSchema } from "@seatwise/shared";
import { addTemplateTablesToWedding, listSeatingTablesForWedding, TemplateNotFoundError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, weddingDeletedResponse, readJson } from "@/lib/api-response";
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

  try {
    const addedCount = await addTemplateTablesToWedding(weddingId, parsed.data.templateId, user.id);
    const tables = await listSeatingTablesForWedding(weddingId);
    return NextResponse.json({ addedCount, tables }, { status: 201 });
  } catch (err) {
    if (err instanceof TemplateNotFoundError) return errorResponse("Template not found", 404);
    // TS-195: the wedding was deleted while this was being saved -- 404, not a server error.
    const gone = weddingDeletedResponse(err);
    if (gone) return gone;
    throw err;
  }
}
