import { NextRequest, NextResponse } from "next/server";
import { updateTableSchema } from "@seatwise/shared";
import {
  updateSeatingTableForWedding,
  getSeatingTableForWedding,
  syncAccessibleTableReassignment,
  deleteSeatingTableForWedding,
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

  const { expectedRevision, ...data } = parsed.data;
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

  // FR-4.6: an isAccessible change (either direction) re-checks anyone currently assigned here
  // who requires an accessible table -- flagging or clearing Needs Reassignment and keeping the
  // current plan version's completeness in sync, in both directions.
  let warnings: string[] = [];
  if (parsed.data.isAccessible !== undefined) {
    const { affectedGuestNames } = await syncAccessibleTableReassignment(weddingId, tableId);
    warnings = affectedGuestNames.map(
      (name) =>
        `${name} requires an accessible table and this one no longer is one — flagged as Needs Reassignment.`
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

  const deleted = await deleteSeatingTableForWedding(tableId, weddingId);
  if (!deleted) return errorResponse("Table not found", 404);

  return NextResponse.json({ ok: true });
}
