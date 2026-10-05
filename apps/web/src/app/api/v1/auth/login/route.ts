import { NextRequest, NextResponse } from "next/server";
import { loginSchema } from "@seatwise/shared";
import { findUserByEmail } from "@seatwise/db";
import { verifyPassword, signToken, setAuthCookie, wantsBearerToken } from "@/lib/auth";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { clientAddress, countSignInAttempt, signInFailureLimits, TOO_MANY_SIGN_INS } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-113: refuse early if this account (from this address, or from everywhere) or this address
  // has already failed too often -- see LOGIN_LIMITS. TS-155: the attempt is counted *before* the
  // password is checked, so many attempts sent at once can't all get in under the limit; a correct
  // password then takes its count back (only failures count).
  const attempt = await countSignInAttempt(signInFailureLimits(parsed.data.email, clientAddress(req)));
  if (!attempt.allowed) {
    // TS-157: a refused attempt never reaches the password check, so it doesn't count against
    // any limit -- otherwise flooding from a blocked address would keep lengthening the
    // account's lockout with tries that were never made against its password.
    await attempt.giveBack();
    return NextResponse.json({ error: TOO_MANY_SIGN_INS }, { status: 429, headers: { "Retry-After": String(attempt.retryAfterSeconds) } });
  }

  const user = await findUserByEmail(parsed.data.email);
  const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
  if (!user || !valid) return errorResponse("Invalid email or password", 401);
  await attempt.giveBack();

  const token = await signToken({ sub: user.id, email: user.email, sessionVersion: user.sessionVersion });

  const response = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email },
    ...(wantsBearerToken(req) ? { token } : {}),
  });
  setAuthCookie(response, token);
  return response;
}
