import { NextRequest, NextResponse } from "next/server";
import { rsvpLinkActionSchema, type RsvpLinkDTO } from "@seatwise/shared";
import { getGuestForWedding, ensureGuestRsvpToken, regenerateGuestRsvpToken, sendEmailNotification } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; guestId: string }> };

// TS-17 (FR-12.4): EDIT-access-gated -- a planner (or any collaborator with edit rights) can get,
// resend, or regenerate a guest's own RSVP link. Deliberately its own endpoint rather than folding
// the raw token into GuestDTO or the general guest routes -- see guests.ts's COLUMNS comment: the
// token is never returned by the normal guest read path, only through this one, narrower one.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, guestId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => ({}));
  const parsed = rsvpLinkActionSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const guest = await getGuestForWedding(guestId, weddingId);
  if (!guest) return errorResponse("Guest not found", 404);

  const token = parsed.data.regenerate
    ? await regenerateGuestRsvpToken(guestId, weddingId)
    : await ensureGuestRsvpToken(guestId, weddingId);
  if (!token) return errorResponse("Guest not found", 404);

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const url = `${appUrl}/rsvp/${token}`;

  // FR-12.4: "resend" is exactly this -- if the guest has an email on file, deliver (or re-deliver)
  // the link to it. A guest with no email still gets a usable link back for the planner to copy
  // and send however they normally would. A failed/unconfigured send never blocks the response
  // (same "never throws" guarantee as every other notification email in the app).
  let emailed = false;
  if (guest.email) {
    const cutoffNote = access.wedding.rsvpCutoffDate
      ? ` Please respond by ${access.wedding.rsvpCutoffDate}.`
      : "";
    await sendEmailNotification(
      guest.email,
      `RSVP for ${access.wedding.name}`,
      `Hi ${guest.firstName},\n\nPlease RSVP for "${access.wedding.name}" here: ${url}\n\nIf you've already responded, this same link shows what you submitted and lets you update it.${cutoffNote}`
    );
    emailed = true;
  }

  const result: RsvpLinkDTO = { url, emailed };
  return NextResponse.json({ rsvp: result });
}
