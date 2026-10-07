import { NextRequest, NextResponse } from "next/server";
import { submitGuestRsvpSchema, type GuestRsvpPreviewDTO, isRsvpCutoffPast } from "@seatwise/shared";
import {
  CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY,
  getGuestByRsvpToken,
  hashLinkToken,
  submitGuestRsvp,
  RsvpSubmissionError,
  notifyWeddingCollaborators,
} from "@seatwise/db";
import { errorResponse, zodErrorResponse, readJson } from "@/lib/api-response";
import { clientAddress, rateLimitOr429, RSVP_LIMITS, RSVP_LINK_TOO_MANY_SUBMITS } from "@/lib/rate-limit";

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
    // TS-160: keyed by the link's hash, so the counters table never holds a working link either.
    // TS-177: this one counts submits on the link from anywhere, so the message can't say "from here".
    (await rateLimitOr429(
      `rsvp:submit:${hashLinkToken(token)}`,
      RSVP_LIMITS.submitsPerLink,
      RSVP_LINK_TOO_MANY_SUBMITS
    ));
  if (limited) return limited;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = submitGuestRsvpSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  let guest: Awaited<ReturnType<typeof submitGuestRsvp>>;
  try {
    const { notes, ...rest } = parsed.data;
    // TS-174: the answer, the attendance change a changed answer brings (TS-167/TS-169: declining
    // gives up the seat, confirming again after declining means waiting for one) and the re-check
    // of their seat (TS-134) are all one transaction inside submitGuestRsvp -- saved together or
    // not at all.
    guest = await submitGuestRsvp(token, { ...rest, rsvpNotes: notes });
  } catch (err) {
    if (err instanceof RsvpSubmissionError) {
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : err.code === "OVER_PARTY_SIZE" ? 422 : 409);
    }
    // TS-174: lost a race with another change to the same wedding (the database broke a deadlock,
    // or something it pointed at was removed). It all rolled back, so nothing was saved -- say so
    // and let the guest send it again, rather than a server error.
    const code = (err as { code?: string } | null)?.code;
    if (code === "40P01" || code === "40001" || code === "23503") {
      return errorResponse("Something changed at the same moment, so your RSVP wasn't saved — nothing was changed. Please send it again.", 409);
    }
    throw err;
  }

  // TS-174: from here on the RSVP is saved. Telling the planner is best effort: a failure is logged,
  // never reported to the guest as their RSVP failing.
  try {
    const changedAnswer = guest.previousRsvpStatus !== guest.rsvpStatus;
    // TS-174: only say a seat was freed when they actually had one.
    const seatNote =
      guest.attendanceChange === "NOT_ATTENDING"
        ? guest.seatFreed
          ? " Their seat has been freed."
          : ""
        : guest.attendanceChange === "ATTENDING"
          ? " They need a seat."
          : "";
    // TS-154 (Tom's decision #2): the planner and collaborators hear about every response.
    const answer =
      guest.rsvpStatus === "CONFIRMED"
        ? `is coming${guest.headcount > 1 ? ` (party of ${guest.headcount})` : ""}`
        : guest.rsvpStatus === "DECLINED"
          ? "can't make it"
          : "updated their RSVP";
    // TS-163: everyone is emailed about a guest's response at most once an hour, however often
    // their link is submitted; each response still shows in the app.
    // TS-169: a changed answer is emailed (the once-an-hour key only holds back repeats), so the
    // planner's inbox never shows "coming" when they've since declined.
    // TS-186 (Tom's decision): but at most 3 changed answers per guest per day -- after that the
    // change only shows in the app, so one guest flipping their answer can't flood the planners.
    await notifyWeddingCollaborators(
      guest.weddingId,
      null,
      "RSVP_RECEIVED",
      `${guest.firstName} ${guest.lastName} ${answer}.${seatNote}`,
      changedAnswer
        ? { emailAtMost: { key: `email:rsvp-changed:day:${guest.id}`, ...CHANGED_RSVP_EMAILS_PER_GUEST_PER_DAY } }
        : { emailOncePer: { key: `email:rsvp-notify:${guest.id}`, windowSeconds: 3600 } }
    );
  } catch (err) {
    console.error("RSVP saved, but notifying the planner failed:", err);
  }
  return NextResponse.json({ ok: true });
}
