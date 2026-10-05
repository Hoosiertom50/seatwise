import { NextRequest, NextResponse } from "next/server";
import { rsvpLinkActionSchema, type RsvpLinkDTO } from "@seatwise/shared";
import { getGuestForWedding } from "@seatwise/db";
import { sendGuestRsvpLink } from "@/lib/rsvp-email";
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

  // TS-143: the same helper sends the automatic email when a guest is added with an address.
  const sent = await sendGuestRsvpLink(guest, access.wedding, user.id, { regenerate: parsed.data.regenerate });
  if (!sent) return errorResponse("Guest not found", 404);
  const link: RsvpLinkDTO = sent;
  return NextResponse.json({ rsvp: link });
}
