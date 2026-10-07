import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MAX_PASSWORD_INPUT } from "@seatwise/shared";
import { deleteUserAccount, findUserById } from "@seatwise/db";
import { getAuthSession, getAuthUser, type NoSessionReason } from "@/lib/session";
import { errorResponse, readJson, zodErrorResponse } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, isSecureCookieContext, verifyPassword } from "@/lib/auth";
import { accountDeleteFailureLimits, clientAddress, countSignInAttempt } from "@/lib/rate-limit";

// TS-204: why there's no signed-in account, for the app (see NoSessionReason in lib/session) --
// a retried "Delete my account" counts as done only when the account is really gone, not when this
// device's session simply ended (logged out in another tab, a password reset) before it arrived.
const NO_SESSION_MESSAGES: Record<NoSessionReason, string> = {
  NO_SESSION: "Not authenticated",
  SESSION_ENDED: "Your session has ended — please sign in again.",
  ACCOUNT_GONE: "This account no longer exists.",
};

export async function GET(req: NextRequest) {
  const session = await getAuthSession(req);
  if (!session.user) {
    return NextResponse.json({ error: NO_SESSION_MESSAGES[session.reason], code: session.reason }, { status: 401 });
  }
  const user = session.user;
  // TS-164: whether the address has been confirmed (drives the "confirm your email" banner).
  return NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerifiedAt !== null },
  });
}

// TS-200: capped like the sign-in password (loginSchema in packages/shared) -- longer than any
// password can be, only a guard against a huge value being hashed.
const deleteSchema = z.object({ password: z.string().min(1, "Enter your password to confirm").max(MAX_PASSWORD_INPUT) });

// TS-105: delete my own account. Needs the password, and is refused (409, with the list) while
// the account still owns any wedding -- those must be handed off first, so no wedding is ever
// left with nobody in charge.
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  // TS-179: refuses a body that isn't JSON (415) here too, not only in proxy.ts.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = deleteSchema.safeParse(json.body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-155: wrong passwords here are limited, so this can't be used to keep guessing the password.
  // TS-186: counted against the sign-in counter for this account from this network address, and
  // this account's own count of wrong passwords when deleting -- no longer the account-wide
  // sign-in counter, which anyone can fill from elsewhere and so stop someone deleting their own
  // account.
  const attempt = await countSignInAttempt(accountDeleteFailureLimits(user.id, user.email, clientAddress(req)));
  if (!attempt.allowed) {
    // TS-157: a refused attempt doesn't count.
    await attempt.giveBack();
    // TS-177: the person is already signed in, so the sign-in wording ("reset your password and
    // sign in") didn't fit -- and a reset doesn't clear these counters anyway.
    // TS-186: worded without saying whose tries they were.
    const minutes = Math.max(1, Math.ceil(attempt.retryAfterSeconds / 60));
    return NextResponse.json(
      { error: `There have been too many tries with a wrong password. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.` },
      { status: 429, headers: { "Retry-After": String(attempt.retryAfterSeconds) } }
    );
  }
  const record = await findUserById(user.id);
  if (!record || !(await verifyPassword(parsed.data.password, record.passwordHash))) {
    return errorResponse("That password isn't right.", 403);
  }
  await attempt.giveBack();

  const result = await deleteUserAccount(user.id);
  // TS-195: it ran into another change at that same moment (a wedding being handed to you, say) --
  // nothing was deleted, and trying again works. Before, this was a server error.
  if (!result.deleted && "tryAgain" in result) {
    return errorResponse(
      "Something else changed on your account at that same moment, so it wasn't deleted. Please try again.",
      409
    );
  }
  if (!result.deleted) {
    return NextResponse.json(
      {
        error: "Hand off every wedding you own before deleting your account.",
        ownedWeddings: result.ownedWeddings,
      },
      { status: 409 }
    );
  }

  const response = NextResponse.json({ ok: true });
  // Same attributes as the cookie was set with (see logout's TS-65 note).
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isSecureCookieContext(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
