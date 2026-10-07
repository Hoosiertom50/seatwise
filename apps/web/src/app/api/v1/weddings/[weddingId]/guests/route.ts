import { NextRequest, NextResponse } from "next/server";
import { createGuestSchema } from "@seatwise/shared";
import {
  createGuest,
  listGuestsByWedding,
  getCurrentPlanVersionStatus,
  notifyWeddingCollaborators,
  refreshPlanAfterGuestAdded,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, weddingDeletedResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { guestForViewer } from "@/lib/guest-privacy";
import { rsvpEmailOutcome, sendGuestRsvpLink } from "@/lib/rsvp-email";
import { SAVED_BUT_NOT_RECHECKED, RSVP_EMAIL_FAILED, afterSave } from "@/lib/post-save";

type Params = { params: Promise<{ weddingId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  // TS-154: private notes only for the owner and Edit collaborators.
  const guests = (await listGuestsByWedding(weddingId)).map((g) => guestForViewer(g, access.accessLevel));
  return NextResponse.json({ guests });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = createGuestSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-169: a guest added as Declined isn't coming, so they're Not Attending and get no seat --
  // the same rule as when a guest declines (TS-167) -- unless attendance was given explicitly.
  const explicitAttendance = (body as { dayOfAttendance?: unknown } | null)?.dayOfAttendance !== undefined;
  let guest: Awaited<ReturnType<typeof createGuest>>;
  try {
    guest = await createGuest(weddingId, {
      ...parsed.data,
      ...(parsed.data.rsvpStatus === "DECLINED" && !explicitAttendance ? { dayOfAttendance: "NOT_ATTENDING" as const } : {}),
    }, access.actor);
  } catch (err) {
    // TS-195: the wedding was deleted while this was being saved -- 404, not a server error.
    const gone = weddingDeletedResponse(err);
    if (gone) return gone;
    throw err;
  }
  // TS-165: a new attending guest makes the current plan incomplete until they're seated.
  // TS-177: the guest is saved by now -- if this re-check fails, say so rather than "not saved".
  const warnings: string[] = [];
  if (guest.dayOfAttendance === "ATTENDING") {
    try {
      await refreshPlanAfterGuestAdded(weddingId, `${guest.firstName} ${guest.lastName}`, user.id);
    } catch (err) {
      console.error("Guest added, but refreshing the plan failed", err);
      warnings.push(SAVED_BUT_NOT_RECHECKED);
    }
  }

  // FR-10.2: guest addition is only notification-worthy post-approval.
  // TS-209: the guest is saved by now -- a failure from here on can't answer an error (Add kept the
  // typed fields, so pressing it again added the guest twice).
  const status = await afterSave("reading the plan's status", () => getCurrentPlanVersionStatus(weddingId), warnings, null, null);
  if (status === "APPROVED") {
    // TS-194: the change above is already saved -- telling people about it is best effort, so a
    // failure is logged and never turns the saved change into an error.
    try {
      await notifyWeddingCollaborators(
        weddingId,
        user.id,
        "GUEST_ADDED",
        `${guest.firstName} ${guest.lastName} was added to the guest list.`
      );
    } catch (err) {
      console.error("Saved, but notifying the wedding's members failed:", err);
    }
  }

  // TS-143 (Tom, 2026-10-02): a guest added with an email gets their RSVP link straight away. (A
  // CSV import never does -- see guest-import -- so a big import can't email everyone by surprise.)
  const rsvpEmail = guest.email
    ? await afterSave("emailing the RSVP link", () => sendGuestRsvpLink(guest, access.wedding, user, { actor: access.actor }), warnings, null, RSVP_EMAIL_FAILED)
    : null;

  return NextResponse.json(
    { guest, warnings, ...(rsvpEmail ? { rsvpEmail: rsvpEmailOutcome(rsvpEmail) } : {}) },
    { status: 201 }
  );
}
