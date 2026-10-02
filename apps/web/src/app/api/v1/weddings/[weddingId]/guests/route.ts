import { NextRequest, NextResponse } from "next/server";
import { createGuestSchema } from "@seatwise/shared";
import { createGuest, listGuestsByWedding, getCurrentPlanVersionStatus, notifyWeddingCollaborators } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { sendGuestRsvpLink } from "@/lib/rsvp-email";

type Params = { params: Promise<{ weddingId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const guests = await listGuestsByWedding(weddingId);
  return NextResponse.json({ guests });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = createGuestSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const guest = await createGuest(weddingId, parsed.data);

  // FR-10.2: guest addition is only notification-worthy post-approval.
  const status = await getCurrentPlanVersionStatus(weddingId);
  if (status === "APPROVED") {
    await notifyWeddingCollaborators(
      weddingId,
      user.id,
      "GUEST_ADDED",
      `${guest.firstName} ${guest.lastName} was added to the guest list.`
    );
  }

  // TS-143 (Tom, 2026-10-02): a guest added with an email gets their RSVP link straight away. (A
  // CSV import never does -- see guest-import -- so a big import can't email everyone by surprise.)
  const rsvpEmail = guest.email ? await sendGuestRsvpLink(guest, access.wedding, user.id) : null;

  return NextResponse.json(
    { guest, ...(rsvpEmail ? { rsvpEmail: { emailed: rsvpEmail.emailed, emailFailed: rsvpEmail.emailFailed, emailLimited: rsvpEmail.emailLimited ?? false } } : {}) },
    { status: 201 }
  );
}
