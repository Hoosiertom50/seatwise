import { NextRequest, NextResponse } from "next/server";
import { updateWeddingSchema } from "@seatwise/shared";
import { getWeddingForOwner, updateWeddingForOwner, deleteWeddingForOwner } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ weddingId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  return NextResponse.json({ wedding });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const existing = await getWeddingForOwner(weddingId, user.id);
  if (!existing) return errorResponse("Wedding not found", 404);

  const body = await req.json().catch(() => null);
  const parsed = updateWeddingSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  await updateWeddingForOwner(weddingId, user.id, parsed.data);
  const wedding = await getWeddingForOwner(weddingId, user.id);
  return NextResponse.json({ wedding });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const deleted = await deleteWeddingForOwner(weddingId, user.id);
  if (!deleted) return errorResponse("Wedding not found", 404);

  return NextResponse.json({ ok: true });
}
