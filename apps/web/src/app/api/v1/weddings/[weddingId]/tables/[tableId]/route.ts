import { NextRequest, NextResponse } from "next/server";
import { updateTableSchema } from "@seatwise/shared";
import {
  updateSeatingTableForWedding,
  getSeatingTableForWedding,
  RestrictedTableError,
  removeSeatingTable,
  TableConflictError,
  type NewlyFlaggedSeat,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse } from "@/lib/api-response";
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
  // TS-181: the table's changes, its required-guest list and the re-check of everyone they affect
  // (FR-4.6 / TS-120 / TS-173) are saved together or not at all. Before, the list went in after
  // the table was saved, so a list that couldn't be saved left the table changed anyway -- even
  // with fewer seats than its required guests need.
  let newlyFlagged: NewlyFlaggedSeat[];
  try {
    const result = await updateSeatingTableForWedding(tableId, weddingId, data, expectedRevision, requiredGuestIds);
    if (!result) return errorResponse("Table not found", 404);
    newlyFlagged = result.newlyFlagged;
  } catch (err) {
    // TS-173/TS-181: a list (or seat count, or accessibility) that breaks a Restricted table's
    // rules -- nothing was saved, and the message says why.
    if (err instanceof RestrictedTableError) return errorResponse(err.message, 422);
    // FR-7.7, extended to seating tables: someone else's edit landed on this table first -- refuse
    // the stale write and hand back the fresh table so the frontend can refresh in one step.
    if (err instanceof TableConflictError) {
      return NextResponse.json({ error: err.message, table: err.table }, { status: 409 });
    }
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }

  // TS-177: a required-guest list change re-checks the tables those guests sit at too, so "this
  // table" (and its new seat count) is only said of guests actually seated at this one.
  const warnings = newlyFlagged.map(({ name, reason, tableId: flaggedAt }) => {
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
  });

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
  // TS-195: how many seated guests the person was told about when they confirmed -- if that's
  // changed by now, they're asked again with the new number instead of the table being removed.
  const seatedParam = req.nextUrl.searchParams.get("seatedCount");
  const confirmedSeatedCount = seatedParam !== null && /^\d{1,6}$/.test(seatedParam) ? Number(seatedParam) : undefined;
  let result: Awaited<ReturnType<typeof removeSeatingTable>>;
  try {
    result = await removeSeatingTable(tableId, weddingId, user.id, confirmed, confirmedSeatedCount);
  } catch (err) {
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
  if (result.status === "NOT_FOUND") return errorResponse("Table not found", 404);
  if (result.status === "NEEDS_CONFIRMATION") {
    const guests = result.seatedCount === 1 ? "1 guest is" : `${result.seatedCount} guests are`;
    // TS-195: said so when the number changed since they confirmed.
    const changed = confirmed && confirmedSeatedCount !== undefined ? "The seating changed since you confirmed — now " : "";
    return NextResponse.json(
      {
        error: `${changed}${guests} seated at "${result.label}" in the current plan. Removing it will leave them unassigned, and removes its seats from saved past versions too.`,
        needsConfirmation: true,
        seatedCount: result.seatedCount,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, unseatedCount: result.seatedCount });
}
