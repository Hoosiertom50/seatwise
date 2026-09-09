import { NextRequest, NextResponse } from "next/server";
import { setEmailNotificationsSchema } from "@seatwise/shared";
import { setEmailNotificationsEnabled } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// FR-10.2: the per-wedding email opt-out. Owner-only, same as other wedding-level settings.
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = setEmailNotificationsSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const updated = await setEmailNotificationsEnabled(weddingId, user.id, parsed.data.emailNotificationsEnabled);
  if (!updated) return errorResponse("Wedding not found", 404);

  return NextResponse.json({ ok: true });
}
