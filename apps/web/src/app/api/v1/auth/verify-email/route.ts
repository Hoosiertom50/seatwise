import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyEmailWithToken } from "@seatwise/db";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { clientAddress, EMAIL_VERIFICATION_LIMITS, rateLimitOr429 } from "@/lib/rate-limit";

const schema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, "This confirmation link isn't valid — ask for a new one."),
});

// TS-164: confirms an email address from the link emailed to it. No sign-in needed -- the person
// may open the link on another device -- since the link itself is the proof.
export async function POST(req: NextRequest) {
  const limited = await rateLimitOr429(`verify-email:addr:${clientAddress(req)}`, EMAIL_VERIFICATION_LIMITS.confirmsPerAddress);
  if (limited) return limited;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const result = await verifyEmailWithToken(parsed.data.token);
  if (!result) {
    return errorResponse("This confirmation link has expired or has already been used. Sign in and ask for a new one.", 400);
  }
  return NextResponse.json({ verified: true });
}
