import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@seatwise/shared";
import { createPasswordResetToken, findUserByEmail, sendEmail, PASSWORD_RESET_TTL_MINUTES, retireOlderResetTokens, emailDelivered } from "@seatwise/db";
import { zodErrorResponse } from "@/lib/api-response";
import { clientAddress, rateLimitOr429, PASSWORD_RESET_LIMITS } from "@/lib/rate-limit";
import { resetOutcome } from "@/lib/password-reset-outcome";

// TS-142: "Forgot password?" -- emails a single-use, 1-hour reset link to an existing account.
// Tom's decision (2026-10-02): say plainly when there's no account for the email (sign-up already
// reveals whether an email is registered, so a vague answer protected nothing). Nothing is ever
// emailed to an address without an account. TS-145: and only say "sent" when it really was.
// Rate-limited per address and per email so it can't flood an inbox.
export async function POST(req: NextRequest) {
  const limited = await rateLimitOr429(`pw-reset:addr:${clientAddress(req)}`, PASSWORD_RESET_LIMITS.requestsPerAddress);
  if (limited) return limited;

  const parsed = forgotPasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return zodErrorResponse(parsed.error);
  const email = parsed.data.email;

  const perEmail = await rateLimitOr429(`pw-reset:email:${email.toLowerCase()}`, PASSWORD_RESET_LIMITS.requestsPerEmail);
  if (perEmail) return perEmail;

  const user = await findUserByEmail(email);
  if (!user) return NextResponse.json(resetOutcome(false, null));

  const token = await createPasswordResetToken(user.id);
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const result = await sendEmail(
    user.email,
    "Reset your Seatwise password",
    `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your Seatwise password. Choose a new one here:\n\n${appUrl}/reset-password/${token}\n\nThis link works once, for ${PASSWORD_RESET_TTL_MINUTES} minutes. If you didn't ask for this, you can ignore this email -- your password hasn't changed.`,
    process.env,
    // TS-163: password resets still go out when the day's everyday email limit is reached.
    { essential: true }
  );
  // TS-153: older links are cancelled only once this one has gone out.
  if (emailDelivered(result)) await retireOlderResetTokens(user.id, token);
  return NextResponse.json(resetOutcome(true, result));
}
