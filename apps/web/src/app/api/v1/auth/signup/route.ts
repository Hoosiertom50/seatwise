import { NextRequest, NextResponse } from "next/server";
import { signupSchema } from "@seatwise/shared";
import { createUser, findUserByEmail } from "@seatwise/db";
import { hashPassword, signToken, AUTH_COOKIE_NAME, isSecureCookieContext } from "@/lib/auth";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const existing = await findUserByEmail(parsed.data.email);
  if (existing) return errorResponse("An account with that email already exists", 409);

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await createUser({
    email: parsed.data.email,
    passwordHash,
    name: parsed.data.name,
  });
  const token = await signToken({ sub: user.id, email: user.email });

  const response = NextResponse.json(
    { user: { id: user.id, name: user.name, email: user.email }, token },
    { status: 201 }
  );
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    // TS-62: see isSecureCookieContext's own doc comment in lib/auth.ts.
    secure: isSecureCookieContext(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
