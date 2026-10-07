import { NextRequest, NextResponse } from "next/server";
import { createInviteSchema } from "@seatwise/shared";
import { inviteEmailText } from "@/lib/outgoing-email-text";
import { confirmEmailFirstMessage } from "@/lib/email-verification";
import {
  createInvite,
  listInvitesForWedding,
  sendEmailNotification,
  emailDelivered,
  emailMayHaveGone,
  InviteError,
  INVITE_TTL_DAYS,
  markInviteEmailed,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { appBaseUrl } from "@/lib/app-url";
import { errorResponse, zodErrorResponse, readJson } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { emailSendRefusedMessage, releaseEmailSend, reserveEmailSend } from "@/lib/rate-limit";

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

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = createInviteSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-164: only an account that has confirmed its own address can have Seatwise email people.
  if (user.emailVerifiedAt === null) return errorResponse(confirmEmailFirstMessage(), 403);

  // TS-178: the link is built from the app's own address -- worked out before anything is counted.
  const appUrl = appBaseUrl();

  // TS-156: every invite sends an email, so invites are capped per sender.
  // TS-177: the message says which limit it was -- the account's daily allowance means tomorrow.
  const reservation = await reserveEmailSend("invites", user.id);
  if (!reservation.allowed) {
    return errorResponse(emailSendRefusedMessage("invites", reservation.reason, reservation.retryAfterSeconds), 429);
  }

  // TS-194: the counts are given back -- from exactly the windows they were made in (the
  // reservation) -- whenever no email went out: not sent, no invite made, or anything else going
  // wrong on the way.
  let emailWentOut = false;
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
    const acceptUrl = `${appUrl}/invites/${invite.token}`;
    const roleLabel = invite.role === "COUPLE" ? "a Couple member" : "a collaborator";
    // TS-156 / TS-163 / TS-171: names only go in if they pass today's rules, and never in the subject.
    const { subject, text } = inviteEmailText({
      inviterName: user.name,
      weddingName: access.wedding.name,
      roleLabel,
      permissionLevel: invite.permissionLevel,
      acceptUrl,
      expiresInDays: INVITE_TTL_DAYS,
    });
    // TS-203: charged to the sender's account (its share of Seatwise's email, and of what one
    // address may receive).
    const sent = await sendEmailNotification(invite.email, subject, text, { account: user.id });
    // TS-171 / TS-178: the invite was made but nothing went out (this address has had its share of
    // email, the day's limit was reached, or the send failed) -- it doesn't use up the sender's
    // allowance (given back below); the owner gets the link to send instead.
    const emailed = emailDelivered(sent);
    // TS-203: an email that may have gone out after all (the mail server went quiet) stays counted.
    emailWentOut = emailMayHaveGone(sent);
    // TS-203: so accepting it confirms the invitee's address (see acceptInvite). Not when the
    // owner is handed the link to send some other way -- and that includes an email that only may
    // have gone out (Copilot review): the owner gets the link then too, and a link they pass on by
    // some other route proves nothing about the invitee's inbox. So an unconfirmed invitee who did
    // get that email confirms their address first (the link in their sign-up email), as before.
    if (emailed) {
      await markInviteEmailed(invite.id).catch((err) => console.error("Couldn't record that an invite was emailed:", err));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- TS-176: the token is left out of the response on purpose.
    const { token: _token, ...invitePublic } = invite;
    // TS-132: if the email didn't go out, hand the owner the accept link to send themselves --
    // otherwise the invitee has no way in. (Accepting still requires signing in with this exact
    // address, so the link is no use to anyone else.)
    // TS-219: `uncertain` -- the email may have been sent (the email service stopped answering
    // part-way), so the screen says "may have been sent" rather than "couldn't be sent".
    return NextResponse.json(
      { invite: invitePublic, emailed, ...(sent === "uncertain" ? { uncertain: true } : {}), ...(emailed ? {} : { acceptUrl }) },
      { status: 201 }
    );
  } catch (err) {
    // TS-168: no invite was made, so no email went out -- this one doesn't count (given back below).
    // TS-195: NOT_OWNER -- handed off a moment ago.
    if (err instanceof InviteError) {
      return errorResponse(err.message, err.code === "NOT_FOUND" ? 404 : err.code === "NOT_OWNER" ? 403 : 409);
    }
    throw err;
  } finally {
    if (!emailWentOut) {
      await releaseEmailSend("invites", user.id, reservation).catch((err) =>
        console.error("Couldn't give back an invite email's count:", err)
      );
    }
  }
}
