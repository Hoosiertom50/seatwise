import { NextRequest, NextResponse } from "next/server";
import { quickCreateTablesSchema } from "@seatwise/shared";
import { quickCreateSeatingTables } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// FR-4.2: create a standard set of tables (e.g. "12 round tables of 8") in one action.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = quickCreateTablesSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const tables = await quickCreateSeatingTables(weddingId, parsed.data);
  return NextResponse.json({ tables }, { status: 201 });
}
