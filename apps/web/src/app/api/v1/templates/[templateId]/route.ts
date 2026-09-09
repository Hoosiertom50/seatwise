import { NextRequest, NextResponse } from "next/server";
import { getTemplateForOwner, deleteTemplateForOwner } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ templateId: string }> };

// TS-19: the detail read (with its full table list) is used both for a "preview before applying"
// view and for the apply-at-creation flow -- ownership-gated the same way as the list endpoint.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { templateId } = await params;
  const template = await getTemplateForOwner(templateId, user.id);
  if (!template) return errorResponse("Template not found", 404);

  return NextResponse.json({ template });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { templateId } = await params;
  const deleted = await deleteTemplateForOwner(templateId, user.id);
  if (!deleted) return errorResponse("Template not found", 404);

  return NextResponse.json({ ok: true });
}
