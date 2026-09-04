import { NextRequest, NextResponse } from "next/server";
import { setRequiredGuestsSchema } from "@seatwise/shared";
import { setRequiredGuestsForTable, RestrictedTableError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; tableId: string }> };

// FR-3.7a: replaces a Restricted table's entire required-guest list in one atomic call — the
// requirement is explicit that an over-capacity or conflicting list "can't be saved", so partial
// updates (add-one/remove-one endpoints) would make that much harder to guarantee.
export async function PUT(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, tableId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = setRequiredGuestsSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const table = await setRequiredGuestsForTable(tableId, weddingId, parsed.data.guestIds);
    return NextResponse.json({ table });
  } catch (err) {
    if (err instanceof RestrictedTableError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
