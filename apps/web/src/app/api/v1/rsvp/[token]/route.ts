import { NextRequest, NextResponse } from "next/server";
import { submitGuestRsvpSchema, type GuestRsvpPreviewDTO } from "@seatwise/shared";
import { getGuestByRsvpToken, submitGuestRsvp, RsvpSubmissionError } from "@seatwise/db";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ token: string }> };

// FR-12.2: the cutoff is a date, not a timestamp -- responses are accepted through the entire
// cutoff day itself, only actually closing off at the start of the next day. Kept in sync with
// the identical check in packages/db/src/queries/guests.ts's submitGuestRsvp.
function isPastCutoff(rsvpCutoffDate: string | null): boolean {
  if (!rsvpCutoffDate) return false;
  return new Date(`${rsvpCutoffDate}T23:59:59`) < new Date();
}

// TS-17 (FR-12.1/FR-12.2): no auth required at all -- a guest reaching their own link may not
// (and needn't) have a Seatwise account. Mirrors the invite-preview pattern in
// /api/v1/invites/[token]: NOT_FOUND for a token that doesn't exist, and here CLOSED (rather than
// a bare error) for a valid token past the wedding's cutoff -- either way pre-filled with
// whatever's already on file, so re-opening the link (open or closed) shows the guest what's
// currently on record instead of a blank form.
export async function GET(_req: NextRequest, { params }: Params) {
  const { token } = await params;
  const guest = await getGuestByRsvpToken(token);

  if (!guest) {
    const preview: GuestRsvpPreviewDTO = { status: "NOT_FOUND" };
    return NextResponse.json({ rsvp: preview });
  }

  const preview: GuestRsvpPreviewDTO = {
    status: isPastCutoff(guest.rsvpCutoffDate) ? "CLOSED" : "OPEN",
    weddingName: guest.weddingName,
    firstName: guest.firstName,
    lastName: guest.lastName,
    headcount: guest.headcount,
    rsvpStatus: guest.rsvpStatus as GuestRsvpPreviewDTO["rsvpStatus"],
    plusOneNames: guest.plusOneNames,
    notes: guest.notes,
    requiresAccessibleTable: guest.requiresAccessibleTable,
    rsvpCutoffDate: guest.rsvpCutoffDate,
  };
  return NextResponse.json({ rsvp: preview });
}

// FR-12.1/FR-12.3: writes straight into the guest's own record via submitGuestRsvp (see that
// function's comment for why no expectedRevision is involved here). Returns only a bare
// confirmation -- deliberately not the full updated guest -- since the caller already has
// everything they submitted; the frontend re-fetches GET to show the just-confirmed state.
export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params;

  const body = await req.json().catch(() => null);
  const parsed = submitGuestRsvpSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    await submitGuestRsvp(token, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RsvpSubmissionError) {
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : 409);
    }
    throw err;
  }
}
