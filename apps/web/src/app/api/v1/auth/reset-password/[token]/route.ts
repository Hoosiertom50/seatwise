import { NextRequest, NextResponse } from "next/server";
import { resetPasswordSchema } from "@seatwise/shared";
import { isPasswordResetTokenUsable, resetPasswordWithToken } from "@seatwise/db";
import { errorResponse, readJson, zodErrorResponse } from "@/lib/api-response";
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
  // TS-179: refuses a body that isn't JSON (415) here too, not only in proxy.ts.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body as { password?: unknown } | null;
  const parsed = resetPasswordSchema.safeParse({ token, password: body?.password });
  if (!parsed.success) return zodErrorResponse(parsed.error);

  // TS-171: check the link before hashing the new password -- hashing is deliberately slow, and
  // shouldn't be done for a link that can't be used. (Using it below is still the real check, so
  // two uses at once can't both succeed.)
  if (!(await isPasswordResetTokenUsable(parsed.data.token))) return errorResponse(NO_LONGER_VALID, 400);

  const user = await resetPasswordWithToken(parsed.data.token, await hashPassword(parsed.data.password));
  if (!user) return errorResponse(NO_LONGER_VALID, 400);

  const response = NextResponse.json({ ok: true });
  setAuthCookie(response, await signToken({ sub: user.id, email: user.email, sessionVersion: user.sessionVersion }));
  return response;
}
