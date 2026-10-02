import { NextRequest, NextResponse } from "next/server";
import { loginSchema } from "@seatwise/shared";
import { findUserByEmail, hitRateLimit, undoRateLimitHit } from "@seatwise/db";
import { verifyPassword, signToken, setAuthCookie } from "@/lib/auth";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { clientAddress, LOGIN_LIMITS, TOO_MANY_SIGN_INS } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-113: refuse early if this account or this address has already failed too often. Keyed by
  // the email as typed (lowercased) whether or not an account exists, so the limit can't be used
  // to discover which emails are registered.
  const accountKey = `login:account:${parsed.data.email.trim().toLowerCase()}`;
  const addressKey = `login:addr:${clientAddress(req)}`;
  // TS-155: the attempt is counted *before* the password is checked, so many attempts sent at once
  // can't all get in under the limit; a correct password then takes its count back (only failures
  // count -- see LOGIN_LIMITS).
  const [byAccount, byAddress] = await Promise.all([
    hitRateLimit(accountKey, LOGIN_LIMITS.failuresPerAccount.limit, LOGIN_LIMITS.failuresPerAccount.windowSeconds),
    hitRateLimit(addressKey, LOGIN_LIMITS.failuresPerAddress.limit, LOGIN_LIMITS.failuresPerAddress.windowSeconds),
  ]);
  if (!byAccount.allowed || !byAddress.allowed) {
    const retryAfter = Math.max(byAccount.allowed ? 0 : byAccount.retryAfterSeconds, byAddress.allowed ? 0 : byAddress.retryAfterSeconds);
    return NextResponse.json({ error: TOO_MANY_SIGN_INS }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }

  const user = await findUserByEmail(parsed.data.email);
  const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
  if (!user || !valid) return errorResponse("Invalid email or password", 401);
  await Promise.all([
    undoRateLimitHit(accountKey, LOGIN_LIMITS.failuresPerAccount.windowSeconds),
    undoRateLimitHit(addressKey, LOGIN_LIMITS.failuresPerAddress.windowSeconds),
  ]);

  const token = await signToken({ sub: user.id, email: user.email, sessionVersion: user.sessionVersion });

  const response = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email },
    token,
  });
  setAuthCookie(response, token);
  return response;
}
