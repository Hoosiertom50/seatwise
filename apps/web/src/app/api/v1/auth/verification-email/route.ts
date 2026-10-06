import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";
import { accountEmailAddressKey, ACCOUNT_EMAIL_LIMITS, clientAddress, EMAIL_VERIFICATION_LIMITS, rateLimitOr429 } from "@/lib/rate-limit";
import { emailNotSentMessage, sendVerificationEmail } from "@/lib/email-verification";
import { emailDelivered, undoRateLimitHit } from "@seatwise/db";

// TS-164: "Resend link" -- emails the signed-in account a fresh confirmation link.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);
  if (user.emailVerifiedAt !== null) return NextResponse.json({ sent: false, alreadyVerified: true });

  const address = clientAddress(req);
  const counters = [
    { key: `verify-email:resend:${user.id}`, ...EMAIL_VERIFICATION_LIMITS.resendsPerAccount },
    // TS-168: per day too, per account and per network address.
    { key: `verify-email:resend:day:${user.id}`, ...EMAIL_VERIFICATION_LIMITS.resendsPerAccountDay },
    { key: `verify-email:resend:addr:day:${address}`, ...EMAIL_VERIFICATION_LIMITS.resendsPerAddressDay },
    // TS-171: counted with sign-ups and password resets from the same address.
    { key: accountEmailAddressKey(address), ...ACCOUNT_EMAIL_LIMITS.perAddressDay },
  ];
  for (const { key, limit, windowSeconds } of counters) {
    const limited = await rateLimitOr429(key, { limit, windowSeconds });
    if (limited) return limited;
  }

  const result = await sendVerificationEmail(user);
  if (!emailDelivered(result)) {
    // TS-178: nothing went out, so this try doesn't use up any of the four allowances above.
    await Promise.all(counters.map(({ key, windowSeconds }) => undoRateLimitHit(key, windowSeconds)));
    return errorResponse(emailNotSentMessage(result), result === "limited" || result === "recipient-limited" ? 429 : 502);
  }
  return NextResponse.json({ sent: true });
}
