import { NextRequest, NextResponse } from "next/server";
import { updateGuestSchema } from "@seatwise/shared";
import {
  getGuestForWedding,
  updateGuestForWedding,
  deleteGuestForWedding,
  getCurrentPlanVersionStatus,
  notifyWeddingCollaborators,
  setGuestAttendance,
  resyncGuestsSeats,
  recomputeCurrentPlanCompleteness,
  resyncGuestSeat,
  guestHasRsvpLink,
  GuestConflictError,
  GuestHeadcountError,
  GuestAccessibleTableError,
  type NewlyFlaggedSeat,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
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

  const { dayOfAttendance, expectedRevision, ...rest } = parsed.data;
  // TS-143: remember whether the guest had an email before this edit -- giving them their first one
  // sends their RSVP link, just like adding a guest with an email does (and TS-154: so does
  // correcting it).
  // TS-169: and what their RSVP answer was, so a change of it can change their attendance.
  const before = rest.email || rest.rsvpStatus ? await getGuestForWedding(guestId, weddingId) : null;

  try {
    const updated = await updateGuestForWedding(guestId, weddingId, rest, expectedRevision);
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
    throw err;
  }

  // An attendance change asked for in this edit *is* part of the save, so a failure there is still
  // an error.
  if (dayOfAttendance !== undefined) {
    await setGuestAttendance(weddingId, guestId, dayOfAttendance, user.id);
  }

  // TS-177: everything below follows from an edit that's already saved -- if any of it fails, the
  // planner is told the edit is saved but the plan couldn't be re-checked, not that it failed.
  const warnings: string[] = [];
  const newlyFlagged: NewlyFlaggedSeat[] = [];
  try {
    if (dayOfAttendance === undefined && rest.rsvpStatus === "DECLINED" && before?.rsvpStatus !== "DECLINED") {
      // TS-167: marking a guest Declined frees their seat, the same as when they decline themselves.
      // (setGuestAttendance does nothing if they're already Not Attending.)
      await setGuestAttendance(weddingId, guestId, "NOT_ATTENDING", user.id);
    } else if (dayOfAttendance === undefined && rest.rsvpStatus && rest.rsvpStatus !== "DECLINED" && before?.rsvpStatus === "DECLINED") {
      // TS-169: and changing them back from Declined brings them back -- Attending, waiting for a seat.
      await setGuestAttendance(weddingId, guestId, "ATTENDING", user.id);
    }

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

  const deleted = await deleteGuestForWedding(guestId, weddingId, user.id);
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
