import { NextRequest, NextResponse } from "next/server";
import { signupSchema } from "@seatwise/shared";
import { createUser, findUserByEmail } from "@seatwise/db";
import { hashPassword, signToken, setAuthCookie } from "@/lib/auth";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { clientAddress, rateLimitOr429, SIGNUP_LIMITS } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // TS-163: counted before anything else (including the password hash, the expensive part).
  const address = clientAddress(req);
  const limited =
    (await rateLimitOr429(`signup:addr:hour:${address}`, SIGNUP_LIMITS.perAddressHour)) ??
    (await rateLimitOr429(`signup:addr:day:${address}`, SIGNUP_LIMITS.perAddressDay));
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const existing = await findUserByEmail(parsed.data.email);
  if (existing) return errorResponse("An account with that email already exists", 409);

  const passwordHash = await hashPassword(parsed.data.password);
  let user;
  try {
    user = await createUser({
      email: parsed.data.email,
      passwordHash,
      name: parsed.data.name,
    });
  } catch (err) {
    // TS-153: two sign-ups for the same email at once (a double-click) -- the second loses the
    // race at the database's unique email rule; answer the same way as the check above.
    if ((err as { code?: string }).code === "23505") {
      return errorResponse("An account with that email already exists", 409);
    }
    throw err;
  }
  const token = await signToken({ sub: user.id, email: user.email, sessionVersion: user.sessionVersion });

  const response = NextResponse.json(
    { user: { id: user.id, name: user.name, email: user.email }, token },
    { status: 201 }
  );
  setAuthCookie(response, token);
  return response;
}
