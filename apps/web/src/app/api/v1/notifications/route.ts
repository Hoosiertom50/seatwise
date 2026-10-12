import { NextRequest, NextResponse } from "next/server";
import { listNotificationsForUser, countUnreadNotifications, markAllNotificationsRead } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, readJson } from "@/lib/api-response";

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
// TS-182: `upTo` (optional) is the newest notification's time the bell had shown -- only those up
// to it are marked, so one that arrived after the list was loaded stays unread.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body as { upTo?: unknown } | null;
  let upTo: Date | undefined;
  if (body && body.upTo !== undefined && body.upTo !== null) {
    upTo = typeof body.upTo === "string" ? new Date(body.upTo) : undefined;
    if (!upTo || Number.isNaN(upTo.getTime())) return errorResponse("upTo must be a date and time", 422);
  }
  await markAllNotificationsRead(user.id, upTo);
  return NextResponse.json({ ok: true });
}
