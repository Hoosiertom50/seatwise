import { NextRequest, NextResponse } from "next/server";
import { updateTableSchema } from "@seatwise/shared";
import { updateSeatingTableForWedding, deleteSeatingTableForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; tableId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, tableId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = updateTableSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const updated = await updateSeatingTableForWedding(tableId, weddingId, parsed.data);
  if (!updated) return errorResponse("Table not found", 404);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, tableId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const deleted = await deleteSeatingTableForWedding(tableId, weddingId);
  if (!deleted) return errorResponse("Table not found", 404);

  return NextResponse.json({ ok: true });
}
