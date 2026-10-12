import { NextRequest, NextResponse } from "next/server";
import { moveGuestAssignmentSchema } from "@seatwise/shared";
import {
  moveGuestAssignment,
  unassignGuestFromPlan,
  ManualMoveError,
  PlanVersionConflictError,
  PlanVersionNotFoundError,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

// TS-10 (Manual Adjustment): move a guest to a different table within the Current Plan
// Version. FR-7.2's hard-rule check (capacity, must-sit/must-not-sit-together, requires an
// accessible table) blocks the move outright with a specific explanation and changes nothing;
// FR-7.3's soft-rule (avoid) conflicts are allowed and come back as warnings. FR-7.6: every
// successful move is recorded as a change-history entry, not a new plan version.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = moveGuestAssignmentSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    // FR-7.5: tableId: null is the undo/redo stack putting a guest back to Unassigned — never a
    // manually-offered "unassign" control, but a real distinct action from moving between tables.
    const { planVersion, warnings } =
      parsed.data.tableId === null
        ? await unassignGuestFromPlan(
            planVersionId,
            weddingId,
            parsed.data.guestId,
            user.id,
            parsed.data.expectedRevision,
            access.actor,
            // TS-208: undo of a seat whose must-sit-together partner was already there.
            parsed.data.onlyGuestIds
          )
        : await moveGuestAssignment(
            planVersionId,
            weddingId,
            parsed.data.guestId,
            parsed.data.tableId,
            user.id,
            parsed.data.expectedRevision,
            // TS-204: read again under the plan's lock.
            access.actor,
            // TS-228: an undo -- refused under the plan's lock if it would split a must-sit group.
            parsed.data.undoSeatsBefore
          );
    return NextResponse.json({ planVersion, warnings });
  } catch (err) {
    // FR-7.7: a stale expectedRevision means someone else's save landed first — the fresh,
    // currently-committed plan version rides along so the client can refresh without a second
    // round-trip, rather than silently reapplying this move on top of what changed.
    if (err instanceof PlanVersionNotFoundError) return errorResponse(err.message, 404);
    if (err instanceof PlanVersionConflictError) {
      return NextResponse.json(
        { error: err.message, planVersion: err.planVersion },
        { status: 409 }
      );
    }
    if (err instanceof ManualMoveError) {
      // TS-197: refused because a newer plan replaced this one -- that plan comes back too, so the
      // screen switches to it.
      if (err.planVersion) return NextResponse.json({ error: err.message, planVersion: err.planVersion }, { status: 409 });
      return errorResponse(err.message, 409);
    }
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
}
