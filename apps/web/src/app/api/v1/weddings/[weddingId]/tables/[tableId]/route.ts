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
  type NewlyFlaggedSeat,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { SAVED_BUT_NOT_RECHECKED } from "@/lib/post-save";

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
  const formerRequiredGuestIds =
    data.isRestricted === false ? ((await getSeatingTableForWedding(tableId, weddingId))?.requiredGuestIds ?? []) : [];
  try {
    const updated = await updateSeatingTableForWedding(tableId, weddingId, data, expectedRevision, requiredGuestIds);
    if (!updated) return errorResponse("Table not found", 404);
  } catch (err) {
    // TS-173: seats lowered below what the table's required guests need -- nothing was saved.
    if (err instanceof RestrictedTableError) return errorResponse(err.message, 422);
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
  const newlyFlagged: NewlyFlaggedSeat[] = [];
  if (requiredGuestIds !== undefined) {
    try {
      newlyFlagged.push(...(await setRequiredGuestsForTable(tableId, weddingId, requiredGuestIds)).newlyFlagged);
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
  // TS-173: a table that stops being Restricted loses its list, so the guests who were on it (and
  // flagged for sitting elsewhere) are re-checked where they sit too.
  // TS-177: the edit itself is saved by now -- a failed re-check mustn't make it look unsaved.
  const recheckWarnings: string[] = [];
  if (data.isAccessible !== undefined || data.capacity !== undefined || data.isRestricted !== undefined) {
    try {
      newlyFlagged.push(...(await resyncTableSeating(weddingId, tableId, formerRequiredGuestIds)).newlyFlagged);
    } catch (err) {
      console.error("Table saved, but re-checking its seating failed", err);
      recheckWarnings.push(SAVED_BUT_NOT_RECHECKED);
    }
  }
  // TS-177: a required-guest list change re-checks the tables those guests sit at too, so "this
  // table" (and its new seat count) is only said of guests actually seated at this one.
  const warnings = [
    ...newlyFlagged.map(({ name, reason, tableId: flaggedAt }) => {
      const here = flaggedAt === tableId;
      return reason === "capacity"
        ? here
          ? `${name} no longer fits at this table${data.capacity !== undefined ? ` (it now seats ${data.capacity})` : ""} — flagged as Needs Reassignment.`
          : `${name} no longer fits at their table — flagged as Needs Reassignment.`
        : reason === "accessible"
          ? here
            ? `${name} requires an accessible table and this one no longer is one — flagged as Needs Reassignment.`
            : `${name} requires an accessible table and their table isn't one — flagged as Needs Reassignment.`
          : reason === "restricted"
            ? here
              ? `${name} isn't on this table's required list any more — flagged as Needs Reassignment.`
              : `${name} isn't on their table's required list — flagged as Needs Reassignment.`
            : `${name} can no longer sit where they are under the seating rules — flagged as Needs Reassignment.`;
    }),
    ...recheckWarnings,
  ];

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
        error: `${guests} seated at "${result.label}" in the current plan. Removing it will leave them unassigned, and removes its seats from saved past versions too.`,
        needsConfirmation: true,
        seatedCount: result.seatedCount,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, unseatedCount: result.seatedCount });
}
