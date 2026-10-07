import { NextRequest, NextResponse } from "next/server";
import { getInviteByToken, acceptInvite, inviteAcceptConfirmsEmail, getWeddingAccessLevel } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { confirmEmailToAcceptMessage } from "@/lib/email-verification-text";

type Params = { params: Promise<{ token: string }> };

// FR-1.4a: "the invitee must accept it while signed in ... with the invited address." Requires
// auth (accepting while signed out isn't possible -- the frontend sends the visitor to sign in
// or sign up with the invited address first) and refuses a signed-in-but-wrong-account attempt
// the same way the GET preview does, without revealing anything about the wedding either.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { token } = await params;
  const invite = await getInviteByToken(token);
  if (!invite) {
    return NextResponse.json({ error: "This invite doesn't exist.", status: "NOT_FOUND" }, { status: 404 });
  }
  // TS-209: a second click, or a retry whose first try went through: this person already accepted it
  // and has access -- they're sent to the wedding, not told the invite is no longer valid.
  if (invite.status === "ACCEPTED" && (await getWeddingAccessLevel(invite.weddingId, user.id))) {
    return NextResponse.json({ weddingId: invite.weddingId, alreadyAccepted: true });
  }
  if (invite.status !== "PENDING") {
    return NextResponse.json(
      { error: "This invite is no longer valid.", status: invite.status },
      { status: 409 }
    );
  }
  // TS-164: an invite is for the person who owns the address -- an account that hasn't confirmed it
  // (anyone could have signed up with it) can't accept until it has.
  // TS-203: unless this invite was emailed to that address: the link only reached that inbox, so
  // accepting it confirms the address. Not for a link the owner copied (its email didn't go out).
  const confirmsEmail = inviteAcceptConfirmsEmail({
    accountEmail: user.email,
    accountConfirmed: user.emailVerifiedAt !== null,
    inviteEmail: invite.email,
    inviteEmailedAt: invite.emailedAt,
  });
  if (user.emailVerifiedAt === null && !confirmsEmail && user.email.toLowerCase() === invite.email.toLowerCase()) {
    return NextResponse.json(
      {
        error: confirmEmailToAcceptMessage(),
        status: "EMAIL_NOT_VERIFIED",
      },
      { status: 403 }
    );
  }
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return NextResponse.json(
      {
        error: "This invite was sent to a different email address. Sign in with that address to accept it.",
        status: "MISMATCHED_ACCOUNT",
      },
      { status: 403 }
    );
  }

  const result = await acceptInvite(token, user.id, { confirmEmail: confirmsEmail });
  if ("error" in result && result.error === "EMAIL_NOT_VERIFIED") {
    return NextResponse.json({ error: confirmEmailToAcceptMessage(), status: "EMAIL_NOT_VERIFIED" }, { status: 403 });
  }
  // TS-209: already a member (their access is left as it is) -- sent to the wedding rather than shown
  // an error with no way there.
  if ("error" in result && result.error === "ALREADY_COLLABORATOR") {
    return NextResponse.json({ weddingId: invite.weddingId, alreadyHadAccess: true });
  }
  // TS-209: two clicks at once -- the other one accepted it for this same person.
  if ("error" in result && result.error === "ACCEPTED" && (await getWeddingAccessLevel(invite.weddingId, user.id))) {
    return NextResponse.json({ weddingId: invite.weddingId, alreadyAccepted: true });
  }
  if ("error" in result) {
    // A race with someone else resolving this invite between the checks above and here -- rare,
    // but handled rather than assumed away.
    return NextResponse.json(
      { error: "This invite is no longer valid.", status: result.error },
      { status: 409 }
    );
  }

  return NextResponse.json({ weddingId: result.weddingId, emailConfirmed: result.emailConfirmed });
}
