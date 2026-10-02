import { NextRequest, NextResponse } from "next/server";
import { resetPasswordSchema } from "@seatwise/shared";
import { isPasswordResetTokenUsable, resetPasswordWithToken } from "@seatwise/db";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { hashPassword, signToken, setAuthCookie } from "@/lib/auth";
import { clientAddress, rateLimitOr429, PASSWORD_RESET_LIMITS } from "@/lib/rate-limit";

type Params = { params: Promise<{ token: string }> };

const NO_LONGER_VALID = "This reset link is no longer valid — request a new one.";

// TS-142: GET says whether a reset link still works (so the page can say so before anyone types a
// new password); POST sets the new password, uses up the link, and signs the planner in.
export async function GET(req: NextRequest, { params }: Params) {
  const limited = await rateLimitOr429(`pw-reset:use:${clientAddress(req)}`, PASSWORD_RESET_LIMITS.resetsPerAddress);
  if (limited) return limited;
  const { token } = await params;
  const usable = /^[0-9a-f]{64}$/.test(token) && (await isPasswordResetTokenUsable(token));
  return NextResponse.json({ usable }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: Params) {
  const limited = await rateLimitOr429(`pw-reset:use:${clientAddress(req)}`, PASSWORD_RESET_LIMITS.resetsPerAddress);
  if (limited) return limited;
  const { token } = await params;
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const parsed = resetPasswordSchema.safeParse({ token, password: body?.password });
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const user = await resetPasswordWithToken(parsed.data.token, await hashPassword(parsed.data.password));
  if (!user) return errorResponse(NO_LONGER_VALID, 400);

  const response = NextResponse.json({ ok: true });
  setAuthCookie(response, await signToken({ sub: user.id, email: user.email }));
  return response;
}
