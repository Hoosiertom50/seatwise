import { NextRequest, NextResponse } from "next/server";
import { markNotificationRead } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ notificationId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { notificationId } = await params;
  const marked = await markNotificationRead(notificationId, user.id);
  if (!marked) return errorResponse("Notification not found", 404);

  return NextResponse.json({ ok: true });
}
