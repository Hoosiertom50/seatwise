import { NextRequest, NextResponse } from "next/server";
import { saveWeddingAsTemplateSchema } from "@seatwise/shared";
import { createTemplateFromWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

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

  const body = await req.json().catch(() => null);
  const parsed = saveWeddingAsTemplateSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const template = await createTemplateFromWedding(user.id, weddingId, parsed.data.name);
  return NextResponse.json({ template }, { status: 201 });
}
