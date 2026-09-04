import { NextRequest, NextResponse } from "next/server";
import { updateGuestSchema } from "@seatwise/shared";
import {
  getGuestForWedding,
  updateGuestForWedding,
  deleteGuestForWedding,
  getCurrentPlanVersionStatus,
  notifyWeddingCollaborators,
  setGuestAttendance,
  revalidateGuestAssignment,
  recomputeCurrentPlanCompleteness,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; guestId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, guestId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const guest = await getGuestForWedding(guestId, weddingId);
  if (!guest) return errorResponse("Guest not found", 404);

  return NextResponse.json({ guest });
}

// FR-2.9: editing a guest's Attendance Status, Side, Relationship Tier, household (partyName),
// or Requires Accessible Table re-checks their current seat assignment against hard rules.
// Attendance Status is special-cased: it already has its own richer FR-8.1 behavior (free the
// seat entirely, don't just flag it) via setGuestAttendance -- routing it through the same
// function here means editing dayOfAttendance from this general endpoint behaves identically to
// editing it from the dedicated Day-of-mode endpoint, instead of silently bypassing the
// seat-freeing/notification logic that endpoint has always had.
const REASSIGNMENT_TRIGGER_FIELDS = ["side", "tier", "partyName", "requiresAccessibleTable"] as const;

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, guestId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = updateGuestSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { dayOfAttendance, ...rest } = parsed.data;

  const updated = await updateGuestForWedding(guestId, weddingId, rest);
  if (!updated) return errorResponse("Guest not found", 404);

  if (dayOfAttendance !== undefined) {
    await setGuestAttendance(weddingId, guestId, dayOfAttendance, user.id);
  }

  const warnings: string[] = [];
  if (REASSIGNMENT_TRIGGER_FIELDS.some((f) => parsed.data[f] !== undefined)) {
    const result = await revalidateGuestAssignment(weddingId, guestId);
    if (result?.flagged) {
      warnings.push(
        `${result.guestName}'s current table no longer fits a hard rule for them — flagged as Needs Reassignment.`
      );
    }
  }

  const guest = await getGuestForWedding(guestId, weddingId);
  return NextResponse.json({ guest, warnings });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, guestId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const guest = await getGuestForWedding(guestId, weddingId);
  if (!guest) return errorResponse("Guest not found", 404);

  const deleted = await deleteGuestForWedding(guestId, weddingId);
  if (!deleted) return errorResponse("Guest not found", 404);

  // FR-2.9: removing a guest cascades away their own seat_assignments row at the DB level, but
  // if they were counted as Unassigned this can flip the plan from incomplete to complete --
  // recompute so isComplete doesn't go stale.
  await recomputeCurrentPlanCompleteness(weddingId);

  // FR-10.2: guest removal is only notification-worthy post-approval.
  const status = await getCurrentPlanVersionStatus(weddingId);
  if (status === "APPROVED") {
    await notifyWeddingCollaborators(
      weddingId,
      user.id,
      "GUEST_REMOVED",
      `${guest.firstName} ${guest.lastName} was removed from the guest list.`
    );
  }

  return NextResponse.json({ ok: true });
}
