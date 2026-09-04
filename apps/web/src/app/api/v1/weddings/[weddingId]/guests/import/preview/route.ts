import { NextRequest, NextResponse } from "next/server";
import { guestImportRequestSchema } from "@seatwise/shared";
import { classifyGuestImport, GuestImportError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// FR-2.4a: writes nothing -- classifies every data row as new/updating/error so the UI can show
// the split before anything is confirmed.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = guestImportRequestSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const preview = await classifyGuestImport(weddingId, parsed.data.csv, parsed.data.mapping);
    return NextResponse.json({ preview });
  } catch (err) {
    if (err instanceof GuestImportError) return errorResponse(err.message, 422);
    throw err;
  }
}
