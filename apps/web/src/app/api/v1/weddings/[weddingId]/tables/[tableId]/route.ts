import { NextRequest, NextResponse } from "next/server";
import { updateTableSchema } from "@seatwise/shared";
import {
  updateSeatingTableForWedding,
  getSeatingTableForWedding,
  resyncTableSeating,
  setRequiredGuestsForTable,
  RestrictedTableError,
  removeSeatingTable,
  TableConflictError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; tableId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, tableId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = updateTableSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { expectedRevision, requiredGuestIds, ...data } = parsed.data;
  try {
    const updated = await updateSeatingTableForWedding(tableId, weddingId, data, expectedRevision);
    if (!updated) return errorResponse("Table not found", 404);
  } catch (err) {
    // FR-7.7, extended to seating tables: someone else's edit landed on this table first -- refuse
    // the stale write and hand back the fresh table so the frontend can refresh in one step.
    if (err instanceof TableConflictError) {
      return NextResponse.json({ error: err.message, table: err.table }, { status: 409 });
    }
    throw err;
  }

  // TS-120: the required-guest list goes in after the table itself (it can only be set once the
  // table is Restricted). The table's other changes are already saved by then, so a list that
  // can't be saved says exactly that rather than pretending the whole edit failed.
  if (requiredGuestIds !== undefined) {
    try {
      await setRequiredGuestsForTable(tableId, weddingId, requiredGuestIds);
    } catch (err) {
      if (err instanceof RestrictedTableError) {
        await resyncTableSeating(weddingId, tableId);
        const table = await getSeatingTableForWedding(tableId, weddingId);
        return NextResponse.json(
          { error: `The table's other changes were saved, but its guest list wasn't: ${err.message}`, table },
          { status: 422 }
        );
      }
      throw err;
    }
  }

  // FR-4.6 / TS-120: an edit that can invalidate who's seated here -- accessible on/off, seats
  // changed, restricted on/off -- re-checks everyone at this table in the current plan, flagging
  // (or clearing) Needs Reassignment and keeping completeness in sync. Nobody is ever unseated.
  let warnings: string[] = [];
  if (
    data.isAccessible !== undefined ||
    data.capacity !== undefined ||
    data.isRestricted !== undefined ||
    requiredGuestIds !== undefined
  ) {
    const { newlyFlagged } = await resyncTableSeating(weddingId, tableId);
    warnings = newlyFlagged.map(({ name, reason }) =>
      reason === "capacity"
        ? `${name} no longer fits at this table (it now seats ${data.capacity}) — flagged as Needs Reassignment.`
        : reason === "accessible"
          ? `${name} requires an accessible table and this one no longer is one — flagged as Needs Reassignment.`
          : reason === "restricted"
            ? `${name} isn't on this table's required list any more — flagged as Needs Reassignment.`
            : `${name} can no longer sit at this table under the seating rules — flagged as Needs Reassignment.`
    );
  }

  const table = await getSeatingTableForWedding(tableId, weddingId);
  return NextResponse.json({ ok: true, table, warnings });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, tableId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-124: a table with guests seated at it in the current plan is only removed once the caller
  // confirms (?confirm=true) -- the 409 says how many, so the UI can ask.
  const confirmed = req.nextUrl.searchParams.get("confirm") === "true";
  const result = await removeSeatingTable(tableId, weddingId, user.id, confirmed);
  if (result.status === "NOT_FOUND") return errorResponse("Table not found", 404);
  if (result.status === "NEEDS_CONFIRMATION") {
    const guests = result.seatedCount === 1 ? "1 guest is" : `${result.seatedCount} guests are`;
    return NextResponse.json(
      {
        error: `${guests} seated at "${result.label}" in the current plan. Removing it will leave them unassigned.`,
        needsConfirmation: true,
        seatedCount: result.seatedCount,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, unseatedCount: result.seatedCount });
}
