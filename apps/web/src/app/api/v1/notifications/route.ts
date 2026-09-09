import { NextRequest, NextResponse } from "next/server";
import { listNotificationsForUser, countUnreadNotifications, markAllNotificationsRead } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

// FR-10.2: this user's in-app notifications across every wedding they own or collaborate on.
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const [notifications, unreadCount] = await Promise.all([
    listNotificationsForUser(user.id),
    countUnreadNotifications(user.id),
  ]);
  return NextResponse.json({ notifications, unreadCount });
}

// Mark every notification read at once (the bell dropdown's "mark all read").
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  await markAllNotificationsRead(user.id);
  return NextResponse.json({ ok: true });
}
