import { NextRequest, NextResponse } from "next/server";
import { updateGuestSchema } from "@seatwise/shared";
import {
  getGuestForWedding,
  updateGuestForWedding,
  deleteGuestForWedding,
  getCurrentPlanVersionStatus,
  notifyWeddingCollaborators,
  resyncGuestsSeats,
  recomputeCurrentPlanCompleteness,
  resyncGuestSeat,
  guestHasRsvpLink,
  GuestConflictError,
  GuestHeadcountError,
  GuestAccessibleTableError,
  AttendanceError,
  type NewlyFlaggedSeat,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { guestForViewer } from "@/lib/guest-privacy";
import { rsvpEmailOutcome, sendGuestRsvpLink } from "@/lib/rsvp-email";
import { SAVED_BUT_NOT_RECHECKED } from "@/lib/post-save";

// TS-177: why a guest edit just flagged someone, in the words that fit the reason.
function flaggedWarning({ name, reason }: NewlyFlaggedSeat): string {
  switch (reason) {
    case "capacity":
      return `${name} no longer fits at their table — flagged as Needs Reassignment.`;
    case "accessible":
      return `${name} needs an accessible table and their current table isn't one — flagged as Needs Reassignment.`;
    case "restricted":
      return `${name} isn't on their table's required list — flagged as Needs Reassignment.`;
    default:
      return `${name}'s current table no longer fits a hard rule for them — flagged as Needs Reassignment.`;
  }
}

type Params = { params: Promise<{ weddingId: string; guestId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, guestId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const guest = await getGuestForWedding(guestId, weddingId);
  if (!guest) return errorResponse("Guest not found", 404);

  // TS-154: private notes only for the owner and Edit collaborators.
  return NextResponse.json({ guest: guestForViewer(guest, access.accessLevel) });
}

// FR-2.9: editing a guest's Attendance Status, Side, Relationship Tier, household (partyName),
// or Requires Accessible Table re-checks their current seat assignment against hard rules.
// Attendance Status is special-cased: it already has its own richer FR-8.1 behavior (free the
// seat entirely, don't just flag it) -- editing dayOfAttendance from this general endpoint behaves
// identically to editing it from the dedicated Day-of-mode endpoint (the same applyAttendanceChange
// and the same notification). TS-195: it's saved in the edit's own transaction (see
// updateGuestForWedding), together with the attendance change a changed RSVP answer brings.
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

  const { expectedRevision, ...rest } = parsed.data;
  // TS-143: remember whether the guest had an email before this edit -- giving them their first one
  // sends their RSVP link, just like adding a guest with an email does (and TS-154: so does
  // correcting it).
  // TS-195: an RSVP answer's effect on attendance is no longer decided from this early read -- it's
  // decided inside the edit, under the guest's lock (their own RSVP could land in between).
  const before = rest.email ? await getGuestForWedding(guestId, weddingId) : null;

  let updated: Awaited<ReturnType<typeof updateGuestForWedding>>;
  try {
    updated = await updateGuestForWedding(guestId, weddingId, rest, expectedRevision, user.id);
    if (!updated) return errorResponse("Guest not found", 404);
  } catch (err) {
    // FR-7.7, extended to guests: someone else's edit landed on this guest first -- refuse the
    // stale write and hand back the fresh guest so the frontend can refresh in one step.
    if (err instanceof GuestConflictError) {
      return NextResponse.json({ error: err.message, guest: err.guest }, { status: 409 });
    }
    // TS-181: a bigger party than their Restricted table can hold for its list -- nothing saved.
    if (err instanceof GuestHeadcountError) return errorResponse(err.message, 422);
    // TS-188: needing an accessible table while required at a Restricted table that isn't one.
    if (err instanceof GuestAccessibleTableError) return errorResponse(err.message, 422);
    // TS-188/TS-195: bringing them back would overfill their Restricted table's list -- the whole
    // edit is refused and nothing of it is saved.
    if (err instanceof AttendanceError) return errorResponse(err.message, 422);
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }

  // FR-10.2: an attendance change is only notification-worthy once the plan has been approved (the
  // same notification as from the Day-of screen). TS-195: sent once the edit is saved; if it fails,
  // that's logged and the saved edit stands.
  if (updated.attendanceChange) {
    try {
      if ((await getCurrentPlanVersionStatus(weddingId)) === "APPROVED") {
        await notifyWeddingCollaborators(
          weddingId,
          user.id,
          "ATTENDANCE_CHANGED",
          updated.attendanceChange === "NOT_ATTENDING"
            ? `${updated.guestName} was marked not attending.`
            : `${updated.guestName} was marked attending again.`
        );
      }
    } catch (err) {
      console.error("Guest saved, but the attendance notification failed", err);
    }
  }

  // TS-177: everything below follows from an edit that's already saved -- if any of it fails, the
  // planner is told the edit is saved but the plan couldn't be re-checked, not that it failed.
  const warnings: string[] = [];
  const newlyFlagged: NewlyFlaggedSeat[] = [];
  try {
    // TS-177: only a flag this edit newly set is reported. Before, a guest already flagged (or
    // flagged because their table is over capacity) got "no longer fits a hard rule" on every edit.
    if (REASSIGNMENT_TRIGGER_FIELDS.some((f) => parsed.data[f] !== undefined)) {
      newlyFlagged.push(...(await resyncGuestsSeats(weddingId, [guestId])).newlyFlagged);
    }

    // TS-134: a bigger party can outgrow the table they're seated at -- re-check its room.
    if (parsed.data.headcount !== undefined) {
      newlyFlagged.push(...(await resyncGuestSeat(weddingId, guestId)).newlyFlagged);
    }
  } catch (err) {
    console.error("Guest saved, but re-checking the seating plan failed", err);
    warnings.push(SAVED_BUT_NOT_RECHECKED);
  }
  const seen = new Set<string>();
  const flagged = newlyFlagged.filter((f) => !seen.has(f.guestId) && !!seen.add(f.guestId));
  warnings.unshift(...flagged.map(flaggedWarning));

  const guest = await getGuestForWedding(guestId, weddingId);
  const firstEmail = !!guest?.email && !!before && !before.email;
  // TS-154 (Tom's decision #3): correcting one address to another makes a fresh link -- the old
  // one stops working, in case it went to the wrong person -- and emails it to the new address.
  const correctedEmail =
    !!guest?.email && !!before?.email && guest.email.trim().toLowerCase() !== before.email.trim().toLowerCase();
  // TS-174: an address added after the old one was cleared is a correction too -- if the guest
  // already has a link (it may have gone to the wrong address), they get a fresh one and the old
  // one stops working. Before, only an address changed in one edit did that.
  const regenerate = correctedEmail || (firstEmail && (await guestHasRsvpLink(guestId, weddingId)));
  const rsvpEmail =
    (firstEmail || correctedEmail) && guest
      ? await sendGuestRsvpLink(guest, access.wedding, user, { regenerate })
      : null;
  return NextResponse.json({
    guest,
    warnings,
    ...(rsvpEmail ? { rsvpEmail: rsvpEmailOutcome(rsvpEmail) } : {}),
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, guestId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const guest = await getGuestForWedding(guestId, weddingId);
  if (!guest) return errorResponse("Guest not found", 404);

  let deleted: boolean;
  try {
    deleted = await deleteGuestForWedding(guestId, weddingId, user.id);
  } catch (err) {
    // TS-187: lost a race with another change (nothing saved) -- 409, not a server error.
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }
  if (!deleted) return errorResponse("Guest not found", 404);

  // FR-2.9: removing a guest cascades away their own seat_assignments row at the DB level, but
  // if they were counted as Unassigned this can flip the plan from incomplete to complete --
  // recompute so isComplete doesn't go stale.
  // TS-189: an attending guest leaving changes the plan's list of guests waiting for a seat, so
  // the plan's revision moves on too (anyone with the old copy refreshes before acting on it).
  // TS-197: that now happens once, inside the delete itself -- this recount only catches up on
  // completeness. The guest is already gone, so a failure here is a warning, not an error.
  const warnings: string[] = [];
  try {
    await recomputeCurrentPlanCompleteness(weddingId);
  } catch (recountErr) {
    console.error("Guest removed, but re-checking the plan failed", recountErr);
    warnings.push(SAVED_BUT_NOT_RECHECKED);
  }

  // FR-10.2: guest removal is only notification-worthy post-approval.
  const status = await getCurrentPlanVersionStatus(weddingId);
  if (status === "APPROVED") {
    // TS-194: the change above is already saved -- telling people about it is best effort, so a
    // failure is logged and never turns the saved change into an error.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        user.id,
        "GUEST_REMOVED",
        `${guest.firstName} ${guest.lastName} was removed from the guest list.`
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
  }

  return NextResponse.json({ ok: true, warnings });
}
