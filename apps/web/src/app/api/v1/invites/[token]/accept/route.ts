import { NextRequest, NextResponse } from "next/server";
import { getInviteByToken, acceptInvite } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

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
  if (invite.status !== "PENDING") {
    return NextResponse.json(
      { error: "This invite is no longer valid.", status: invite.status },
      { status: 409 }
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

  const result = await acceptInvite(token, user.id);
  if ("error" in result) {
    // A race with someone else resolving this invite between the checks above and here -- rare,
    // but handled rather than assumed away.
    return NextResponse.json(
      { error: "This invite is no longer valid.", status: result.error },
      { status: 409 }
    );
  }

  return NextResponse.json({ weddingId: result.weddingId });
}
