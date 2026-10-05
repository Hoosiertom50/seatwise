import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { EMAIL_VERIFICATION_LIMITS, rateLimitOr429 } from "@/lib/rate-limit";
import { sendVerificationEmail } from "@/lib/email-verification";

// TS-164: "Resend link" -- emails the signed-in account a fresh confirmation link.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  if (user.emailVerifiedAt !== null) return NextResponse.json({ sent: false, alreadyVerified: true });

  const limited = await rateLimitOr429(`verify-email:resend:${user.id}`, EMAIL_VERIFICATION_LIMITS.resendsPerAccount);
  if (limited) return limited;

  const sent = await sendVerificationEmail(user);
  if (!sent) return errorResponse("We couldn't send the email just now — please try again in a few minutes.", 502);
  return NextResponse.json({ sent: true });
}
