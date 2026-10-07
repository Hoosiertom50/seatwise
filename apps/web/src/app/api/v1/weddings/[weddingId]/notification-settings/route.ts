import { NextRequest, NextResponse } from "next/server";
import { setEmailNotificationsSchema, setMyEmailNotificationsSchema } from "@seatwise/shared";
import { getMyEmailNotifications, setEmailNotificationsEnabled, setMyEmailNotifications } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-213: your own "Email me about this wedding" switch -- anyone with access, for themselves.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const mine = await getMyEmailNotifications(weddingId, user.id);
  if (mine === null) return errorResponse("Wedding not found", 404);
  return NextResponse.json({ myEmailNotificationsEnabled: mine }, { headers: { "Cache-Control": "no-store" } });
}

// FR-10.2: the per-wedding email opt-out. Owner-only, same as other wedding-level settings.
// TS-213: and each member's own switch ({ myEmailNotificationsEnabled }), which anyone with access
// can change for themselves -- before, only the owner could turn emails off, and only for everyone,
// so a View-access member's only way to stop them was to leave the wedding.
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const body = await req.json().catch(() => null);

  const mine = setMyEmailNotificationsSchema.safeParse(body);
  if (mine.success) {
    const access = await requireAccess(weddingId, user.id, "VIEW");
    if ("error" in access) return access.error;
    const updated = await setMyEmailNotifications(weddingId, user.id, mine.data.myEmailNotificationsEnabled);
    if (!updated) return errorResponse("Wedding not found", 404);
    return NextResponse.json({ ok: true, myEmailNotificationsEnabled: mine.data.myEmailNotificationsEnabled });
  }

  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const parsed = setEmailNotificationsSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const updated = await setEmailNotificationsEnabled(weddingId, user.id, parsed.data.emailNotificationsEnabled);
  if (!updated) return errorResponse("Wedding not found", 404);

  return NextResponse.json({ ok: true });
}
