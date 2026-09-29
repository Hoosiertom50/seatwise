import { NextRequest, NextResponse } from "next/server";
import { loginSchema } from "@seatwise/shared";
import { findUserByEmail, hitRateLimit } from "@seatwise/db";
import { verifyPassword, signToken, setAuthCookie } from "@/lib/auth";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { clientAddress, LOGIN_LIMITS, over429, TOO_MANY_SIGN_INS } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-113: refuse early if this account or this address has already failed too often. Keyed by
  // the email as typed (lowercased) whether or not an account exists, so the limit can't be used
  // to discover which emails are registered.
  const accountKey = `login:account:${parsed.data.email.trim().toLowerCase()}`;
  const addressKey = `login:addr:${clientAddress(req)}`;
  const limited =
    (await over429(accountKey, LOGIN_LIMITS.failuresPerAccount, TOO_MANY_SIGN_INS)) ??
    (await over429(addressKey, LOGIN_LIMITS.failuresPerAddress, TOO_MANY_SIGN_INS));
  if (limited) return limited;

  const user = await findUserByEmail(parsed.data.email);
  const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
  if (!user || !valid) {
    // Only failures count -- see LOGIN_LIMITS.
    await hitRateLimit(accountKey, LOGIN_LIMITS.failuresPerAccount.limit, LOGIN_LIMITS.failuresPerAccount.windowSeconds);
    await hitRateLimit(addressKey, LOGIN_LIMITS.failuresPerAddress.limit, LOGIN_LIMITS.failuresPerAddress.windowSeconds);
    return errorResponse("Invalid email or password", 401);
  }

  const token = await signToken({ sub: user.id, email: user.email });

  const response = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email },
    token,
  });
  setAuthCookie(response, token);
  return response;
}
