import { NextRequest, NextResponse } from "next/server";
import { saveWeddingAsTemplateSchema } from "@seatwise/shared";
import { createTemplateFromWedding, type UserRow } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson, weddingDeletedResponse } from "@/lib/api-response";
import { requireAccess, type GrantedAccess } from "@/lib/access";
import { limitedWeddingWork } from "@/lib/rate-limit";

type Params = { params: Promise<{ weddingId: string }> };

// TS-19 (FR-14.1/FR-14.2): captures this wedding's current table layout + Side-Mixing setting as a
// brand-new template owned by whoever saves it (not by the wedding) -- EDIT access on the source
// wedding is enough, same gate as every other "create a new record from this wedding" action
// (creating a table, a timeline entry, etc).
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-205: an hourly limit per account on saving templates.
  return limitedWeddingWork("saveTemplate", user.id, () => saveTemplate(req, weddingId, user, access));
}

async function saveTemplate(req: NextRequest, weddingId: string, user: UserRow, access: GrantedAccess): Promise<Response> {

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = saveWeddingAsTemplateSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  let template: Awaited<ReturnType<typeof createTemplateFromWedding>>;
  try {
    template = await createTemplateFromWedding(user.id, weddingId, parsed.data.name, access.actor);
  } catch (err) {
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    const refused = weddingDeletedResponse(err);
    if (refused) return refused;
    throw err;
  }
  return NextResponse.json({ template }, { status: 201 });
}
