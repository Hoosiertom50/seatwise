import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyEmailWithToken } from "@seatwise/db";
import { errorResponse, readJson, zodErrorResponse } from "@/lib/api-response";
import { clientAddress, EMAIL_VERIFICATION_LIMITS, rateLimitOr429 } from "@/lib/rate-limit";

const schema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, "This confirmation link isn't valid — ask for a new one."),
});

// TS-164: confirms an email address from the link emailed to it. No sign-in needed -- the person
// may open the link on another device -- since the link itself is the proof.
export async function POST(req: NextRequest) {
  const limited = await rateLimitOr429(`verify-email:addr:${clientAddress(req)}`, EMAIL_VERIFICATION_LIMITS.confirmsPerAddress);
  if (limited) return limited;

  // TS-179: refuses a body that isn't JSON (415) here too, not only in proxy.ts.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const result = await verifyEmailWithToken(parsed.data.token);
  if (!result) {
    return errorResponse(// TS-177: confirming uses up every older link too, so an older email's link lands here even
    // though there's nothing left to do.
    "This confirmation link has expired or was already used. If you've already confirmed your email, you're all set — otherwise sign in and use \"Resend link\" to get a new one.", 400);
  }
  return NextResponse.json({ verified: true });
}
