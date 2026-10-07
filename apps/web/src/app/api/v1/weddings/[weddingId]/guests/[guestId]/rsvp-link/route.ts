import { NextRequest, NextResponse } from "next/server";
import { rsvpLinkActionSchema, type RsvpLinkDTO } from "@seatwise/shared";
import { ensureGuestRsvpToken, getGuestForWedding, readGuestRsvpToken } from "@seatwise/db";
import { sendGuestRsvpLink } from "@/lib/rsvp-email";
import { rsvpLinkAfterFailure } from "@/lib/after-commit-answers";
import { appBaseUrl } from "@/lib/app-url";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson, weddingDeletedResponse } from "@/lib/api-response";
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

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body ?? {};
  const parsed = rsvpLinkActionSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const guest = await getGuestForWedding(guestId, weddingId);
  if (!guest) return errorResponse("Guest not found", 404);

  const regenerate = parsed.data.regenerate;
  const readToken = () => ensureGuestRsvpToken(guest.id, weddingId, access.actor);
  // TS-143: the same helper sends the automatic email when a guest is added with an address.
  let sent: Awaited<ReturnType<typeof sendGuestRsvpLink>>;
  // TS-220: for "New link", the link before it -- so a failure can tell whether the new one was made.
  let previousToken: string | null = null;
  if (regenerate) {
    try {
      // TS-228: read only -- for a guest with no link yet this used to make one, replaced a moment later.
      previousToken = await readGuestRsvpToken(guest.id, weddingId);
    } catch (err) {
      const refused = weddingDeletedResponse(err);
      if (refused) return refused;
      throw err;
    }
  }
  try {
    // TS-204: the link is made with the person's access read again in the same transaction.
    sent = await sendGuestRsvpLink(guest, access.wedding, user, { regenerate, actor: access.actor });
  } catch (err) {
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    const refused = weddingDeletedResponse(err);
    if (refused) return refused;
    // TS-220: the link may already be saved (for "New link", the old one is then dead) when
    // emailing it fails -- counting or the cooldown. That part is best effort: the planner still
    // gets the link, marked as not emailed, rather than an error that hides it.
    const recovered = await rsvpLinkAfterFailure({
      regenerate,
      previousToken,
      readToken,
      appUrl: appBaseUrl,
      hasEmail: !!guest.email,
    });
    if (!recovered) throw err;
    console.error("RSVP link saved, but emailing it failed:", err);
    sent = recovered;
  }
  if (!sent) return errorResponse("Guest not found", 404);
  const link: RsvpLinkDTO = sent;
  return NextResponse.json({ rsvp: link });
}
