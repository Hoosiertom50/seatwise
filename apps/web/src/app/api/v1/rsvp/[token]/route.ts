import { NextRequest, NextResponse } from "next/server";
import { submitGuestRsvpSchema, type GuestRsvpPreviewDTO, isRsvpCutoffPast } from "@seatwise/shared";
import { getGuestByRsvpToken, submitGuestRsvp, RsvpSubmissionError, resyncGuestSeat, notifyWeddingCollaborators } from "@seatwise/db";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { clientAddress, rateLimitOr429, RSVP_LIMITS } from "@/lib/rate-limit";

type Params = { params: Promise<{ token: string }> };

// FR-12.2: the cutoff is a date, not a timestamp -- responses are accepted through the entire
// cutoff day itself, only actually closing off at the start of the next day. Kept in sync with
// the identical check in packages/db/src/queries/guests.ts's submitGuestRsvp.
// TS-153: shared with submitGuestRsvp -- see packages/shared/src/rsvp-cutoff.ts.
function isPastCutoff(rsvpCutoffDate: string | null): boolean {
  return isRsvpCutoffPast(rsvpCutoffDate);
}

// TS-17 (FR-12.1/FR-12.2): no auth required at all -- a guest reaching their own link may not
// (and needn't) have a Seatwise account. Mirrors the invite-preview pattern in
// /api/v1/invites/[token]: NOT_FOUND for a token that doesn't exist, and here CLOSED (rather than
// a bare error) for a valid token past the wedding's cutoff -- either way pre-filled with
// whatever's already on file, so re-opening the link (open or closed) shows the guest what's
// currently on record instead of a blank form.
// TS-149: a guest's name and RSVP details are behind this link; never cached anywhere.
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params;
  // TS-98: this endpoint needs no sign-in, so it's rate-limited per network address.
  const limited = await rateLimitOr429(`rsvp:addr:${clientAddress(req)}`, RSVP_LIMITS.perAddress);
  if (limited) return limited;
  const guest = await getGuestByRsvpToken(token);

  if (!guest) {
    const preview: GuestRsvpPreviewDTO = { status: "NOT_FOUND" };
    return NextResponse.json({ rsvp: preview }, { headers: NO_STORE });
  }

  const preview: GuestRsvpPreviewDTO = {
    status: isPastCutoff(guest.rsvpCutoffDate) ? "CLOSED" : "OPEN",
    weddingName: guest.weddingName,
    firstName: guest.firstName,
    lastName: guest.lastName,
    headcount: guest.headcount,
    maxHeadcount: guest.partySizeLimit,
    rsvpStatus: guest.rsvpStatus as GuestRsvpPreviewDTO["rsvpStatus"],
    plusOneNames: guest.plusOneNames,
    // TS-107: the guest's own RSVP note -- never the planner's private `notes`.
    notes: guest.rsvpNotes,
    requiresAccessibleTable: guest.requiresAccessibleTable,
    rsvpCutoffDate: guest.rsvpCutoffDate,
  };
  return NextResponse.json({ rsvp: preview }, { headers: NO_STORE });
}

// FR-12.1/FR-12.3: writes straight into the guest's own record via submitGuestRsvp (see that
// function's comment for why no expectedRevision is involved here). Returns only a bare
// confirmation -- deliberately not the full updated guest -- since the caller already has
// everything they submitted; the frontend re-fetches GET to show the just-confirmed state.
export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params;
  // TS-98: per network address, and per guest link -- so neither one flooding source nor one
  // leaked link can hammer a guest's record.
  const limited =
    (await rateLimitOr429(`rsvp:addr:${clientAddress(req)}`, RSVP_LIMITS.perAddress)) ??
    (await rateLimitOr429(`rsvp:submit:${token}`, RSVP_LIMITS.submitsPerLink));
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = submitGuestRsvpSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    const { notes, ...rest } = parsed.data;
    const guest = await submitGuestRsvp(token, { ...rest, rsvpNotes: notes });
    // TS-134: a guest who now needs an accessible seat, or is bringing more people than their
    // table has room for, is flagged Needs Reassignment -- exactly as a planner's own edit would --
    // instead of silently staying where they no longer fit.
    await resyncGuestSeat(guest.weddingId, guest.id);
    // TS-154 (Tom's decision #2): the planner and collaborators hear about every response.
    const answer =
      guest.rsvpStatus === "CONFIRMED"
        ? `is coming${guest.headcount > 1 ? ` (party of ${guest.headcount})` : ""}`
        : guest.rsvpStatus === "DECLINED"
          ? "can't make it"
          : "updated their RSVP";
    await notifyWeddingCollaborators(guest.weddingId, null, "RSVP_RECEIVED", `${guest.firstName} ${guest.lastName} ${answer}.`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RsvpSubmissionError) {
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : err.code === "OVER_PARTY_SIZE" ? 422 : 409);
    }
    throw err;
  }
}
