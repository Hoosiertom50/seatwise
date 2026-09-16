import { NextRequest, NextResponse } from "next/server";
import { loginSchema } from "@seatwise/shared";
import { findUserByEmail } from "@seatwise/db";
import { verifyPassword, signToken, AUTH_COOKIE_NAME, isSecureCookieContext } from "@/lib/auth";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const user = await findUserByEmail(parsed.data.email);
  if (!user) return errorResponse("Invalid email or password", 401);

  const valid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!valid) return errorResponse("Invalid email or password", 401);

  const token = await signToken({ sub: user.id, email: user.email });

  const response = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email },
    token,
  });
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    // TS-62 SPIKE (DO NOT MERGE): see isSecureCookieContext's own doc comment in lib/auth.ts.
    secure: isSecureCookieContext(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
