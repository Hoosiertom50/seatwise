import { NextRequest, NextResponse } from "next/server";
import { createWeddingSchema } from "@seatwise/shared";
import { createWedding, listWeddingsByOwner } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const weddings = await listWeddingsByOwner(user.id);
  return NextResponse.json({ weddings });
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const body = await req.json().catch(() => null);
  const parsed = createWeddingSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const wedding = await createWedding(user.id, parsed.data);
  return NextResponse.json({ wedding }, { status: 201 });
}
