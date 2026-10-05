import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteUserAccount, findUserById, hitRateLimit, undoRateLimitHit } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, isSecureCookieContext, verifyPassword } from "@/lib/auth";
import { LOGIN_LIMITS, TOO_MANY_SIGN_INS } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  // TS-164: whether the address has been confirmed (drives the "confirm your email" banner).
  return NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerifiedAt !== null },
  });
}

const deleteSchema = z.object({ password: z.string().min(1, "Enter your password to confirm") });

// TS-105: delete my own account. Needs the password, and is refused (409, with the list) while
// the account still owns any wedding -- those must be handed off first, so no wedding is ever
// left with nobody in charge.
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-155: wrong passwords here count against the same per-account limit as signing in, so this
  // can't be used to keep guessing the password.
  const { limit, windowSeconds } = LOGIN_LIMITS.failuresPerAccount;
  const accountKey = `login:account:${user.email.toLowerCase()}`;
  if (!(await hitRateLimit(accountKey, limit, windowSeconds)).allowed) {
    // TS-157: a refused attempt doesn't count.
    await undoRateLimitHit(accountKey, windowSeconds);
    return errorResponse(TOO_MANY_SIGN_INS, 429);
  }
  const record = await findUserById(user.id);
  if (!record || !(await verifyPassword(parsed.data.password, record.passwordHash))) {
    return errorResponse("That password isn't right.", 403);
  }
  await undoRateLimitHit(accountKey, windowSeconds);

  const result = await deleteUserAccount(user.id);
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
