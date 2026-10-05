import { NextRequest, NextResponse } from "next/server";
import { createInviteSchema } from "@seatwise/shared";
import { inviteEmailText } from "@/lib/outgoing-email-text";
import { confirmEmailFirstMessage } from "@/lib/email-verification";
import { createInvite, listInvitesForWedding, sendEmailNotification, emailDelivered, InviteError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { releaseEmailSend, reserveEmailSend, TOO_MANY_INVITES } from "@/lib/rate-limit";

type Params = { params: Promise<{ weddingId: string }> };

// FR-1.4/FR-1.4a: owner-only. Listing (for the Collaborators tab's invite-management view) is
// available to the owner only, same as managing collaborators directly -- an invite's target
// email is itself sensitive enough that other collaborators shouldn't see who else was invited.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const invites = await listInvitesForWedding(weddingId);
  return NextResponse.json({ invites });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "OWNER");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = createInviteSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-164: only an account that has confirmed its own address can have Seatwise email people.
  if (user.emailVerifiedAt === null) return errorResponse(confirmEmailFirstMessage(user.email), 403);

  // TS-156: every invite sends an email, so invites are capped per sender.
  if (!(await reserveEmailSend("invites", user.id))) return errorResponse(TOO_MANY_INVITES, 429);

  try {
    const invite = await createInvite(
      weddingId,
      user.id,
      parsed.data.email,
      parsed.data.permissionLevel,
      parsed.data.role
    );

    // FR-1.4a: the email itself carries no guest data -- just who invited them, to what wedding
    // (by name only), at what role/level, and the accept link. A failed/unconfigured send never
    // blocks the invite from being created (same guarantee as every other notification email).
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    const acceptUrl = `${appUrl}/invites/${invite.token}`;
    const roleLabel = invite.role === "COUPLE" ? "a Couple member" : "a collaborator";
    // TS-156 / TS-163 / TS-171: names only go in if they pass today's rules, and never in the subject.
    const { subject, text } = inviteEmailText({
      inviterName: user.name,
      weddingName: access.wedding.name,
      roleLabel,
      permissionLevel: invite.permissionLevel,
      acceptUrl,
    });
    const sent = await sendEmailNotification(invite.email, subject, text);
    // TS-171: the invite was made but nothing went out (this address has had its share of email
    // today) -- it doesn't use up the sender's allowance; the owner gets the link to send instead.
    if (sent === "recipient-limited") await releaseEmailSend("invites", user.id);

    const { token: _token, ...invitePublic } = invite;
    // TS-132: if the email didn't go out, hand the owner the accept link to send themselves --
    // otherwise the invitee has no way in. (Accepting still requires signing in with this exact
    // address, so the link is no use to anyone else.)
    const emailed = emailDelivered(sent);
    return NextResponse.json(
      { invite: invitePublic, emailed, ...(emailed ? {} : { acceptUrl }) },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof InviteError) {
      // TS-168: no invite was made, so no email went out -- this one doesn't count.
      await releaseEmailSend("invites", user.id);
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : 409);
    }
    throw err;
  }
}
