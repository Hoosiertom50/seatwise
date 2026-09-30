import { NextRequest, NextResponse } from "next/server";
import { setRequiredGuestsSchema } from "@seatwise/shared";
import { setRequiredGuestsForTable, RestrictedTableError, resyncTableSeating } from "@seatwise/db";
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
    // TS-120: someone already seated here who's no longer on the list is flagged, never unseated.
    const { newlyFlagged } = await resyncTableSeating(weddingId, tableId);
    const warnings = newlyFlagged.map(({ name, reason }) =>
      reason === "restricted"
        ? `${name} isn't on this table's required list any more — flagged as Needs Reassignment.`
        : `${name} can no longer sit at this table — flagged as Needs Reassignment.`
    );
    return NextResponse.json({ table, warnings });
  } catch (err) {
    if (err instanceof RestrictedTableError) {
      return errorResponse(err.message, 409);
    }
    throw err;
  }
}
