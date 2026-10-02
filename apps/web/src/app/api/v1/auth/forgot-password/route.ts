import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@seatwise/shared";
import { createPasswordResetToken, findUserByEmail, sendEmail, PASSWORD_RESET_TTL_MINUTES } from "@seatwise/db";
import { zodErrorResponse } from "@/lib/api-response";
import { clientAddress, rateLimitOr429, PASSWORD_RESET_LIMITS } from "@/lib/rate-limit";

// TS-142: "Forgot password?" -- emails a single-use, 1-hour reset link. Always gives the same
// answer whether or not the email has an account, so it can't be used to find out who's signed
// up. Rate-limited per address and per email so it can't be used to flood an inbox.
const GENERIC_RESET_MESSAGE =
  "If that email has a Seatwise account, we've sent a link to reset the password. It works for 1 hour.";

export async function POST(req: NextRequest) {
  const limited = await rateLimitOr429(`pw-reset:addr:${clientAddress(req)}`, PASSWORD_RESET_LIMITS.requestsPerAddress);
  if (limited) return limited;

  const parsed = forgotPasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return zodErrorResponse(parsed.error);
  const email = parsed.data.email;

  const perEmail = await rateLimitOr429(`pw-reset:email:${email.toLowerCase()}`, PASSWORD_RESET_LIMITS.requestsPerEmail);
  if (perEmail) return perEmail;

  const user = await findUserByEmail(email);
  if (user) {
    const token = await createPasswordResetToken(user.id);
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    await sendEmail(
      user.email,
      "Reset your Seatwise password",
      `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your Seatwise password. Choose a new one here:\n\n${appUrl}/reset-password/${token}\n\nThis link works once, for ${PASSWORD_RESET_TTL_MINUTES} minutes. If you didn't ask for this, you can ignore this email -- your password hasn't changed.`
    );
  }
  return NextResponse.json({ message: GENERIC_RESET_MESSAGE });
}
