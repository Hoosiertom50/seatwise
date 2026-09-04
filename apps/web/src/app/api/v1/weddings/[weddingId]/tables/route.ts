import { NextRequest, NextResponse } from "next/server";
import { createTableSchema } from "@seatwise/shared";
import { getWeddingForOwner, createSeatingTable, listSeatingTablesForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ weddingId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  const tables = await listSeatingTablesForWedding(weddingId);
  return NextResponse.json({ tables });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  const body = await req.json().catch(() => null);
  const parsed = createTableSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const table = await createSeatingTable(weddingId, parsed.data);
  return NextResponse.json({ table }, { status: 201 });
}
