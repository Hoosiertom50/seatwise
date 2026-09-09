import { NextRequest, NextResponse } from "next/server";
import type { InvitePreviewDTO } from "@seatwise/shared";
import { getInviteByToken } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";

type Params = { params: Promise<{ token: string }> };

// FR-1.4a: no auth required to look this up -- an invite email recipient may not have an account
// (or session) yet -- but the response is deliberately minimal for anything but a genuinely
// PENDING, address-matching invite: an expired, revoked, already-accepted, or mismatched-account
// invite reveals only its status, never the wedding's name or anything else about it.
export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params;
  const invite = await getInviteByToken(token);

  if (!invite) {
    const preview: InvitePreviewDTO = { status: "NOT_FOUND" };
    return NextResponse.json({ invite: preview });
  }

  if (invite.status !== "PENDING") {
    const preview: InvitePreviewDTO = { status: invite.status };
    return NextResponse.json({ invite: preview });
  }

  const user = await getAuthUser(req);
  if (user && user.email.toLowerCase() !== invite.email.toLowerCase()) {
    const preview: InvitePreviewDTO = { status: "MISMATCHED_ACCOUNT" };
    return NextResponse.json({ invite: preview });
  }

  const preview: InvitePreviewDTO = {
    status: "PENDING",
    weddingName: invite.weddingName,
    role: invite.role,
    permissionLevel: invite.permissionLevel,
    invitedEmail: invite.email,
  };
  return NextResponse.json({ invite: preview });
}
