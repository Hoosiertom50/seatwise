import { NextRequest, NextResponse } from "next/server";
import { signupSchema } from "@seatwise/shared";
import { createUser, findUserByEmail } from "@seatwise/db";
import { hashPassword, signToken, setAuthCookie, wantsBearerToken } from "@/lib/auth";
import { errorResponse, readJson, zodErrorResponse } from "@/lib/api-response";
import { networkRateLimitOr429, perNetworkCounters, SIGNUP_LIMITS } from "@/lib/rate-limit";
import { sendFirstConfirmationEmail } from "@/lib/signup-email";

export async function POST(req: NextRequest) {
  // TS-163: counted before anything else (including the password hash, the expensive part).
  // TS-219: per address (an IPv4 address, or an IPv6 /64) as before, and for IPv6 its /48 too.
  const limited = await networkRateLimitOr429([
    ...perNetworkCounters(req, (network) => `signup:addr:hour:${network}`, SIGNUP_LIMITS.perAddressHour, SIGNUP_LIMITS.perWiderNetworkHour),
    ...perNetworkCounters(req, (network) => `signup:addr:day:${network}`, SIGNUP_LIMITS.perAddressDay, SIGNUP_LIMITS.perWiderNetworkDay),
  ]);
  if (limited) return limited;

  // TS-179: refuses a body that isn't JSON (415) here too, not only in proxy.ts.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = signupSchema.safeParse(json.body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const existing = await findUserByEmail(parsed.data.email);
  if (existing) return errorResponse("An account with that email already exists", 409);

  const passwordHash = await hashPassword(parsed.data.password);
  let user;
  try {
    user = await createUser({
      email: parsed.data.email,
      passwordHash,
      name: parsed.data.name,
    });
  } catch (err) {
    // TS-153: two sign-ups for the same email at once (a double-click) -- the second loses the
    // race at the database's unique email rule; answer the same way as the check above.
    if ((err as { code?: string }).code === "23505") {
      return errorResponse("An account with that email already exists", 409);
    }
    throw err;
  }
  const token = await signToken({ sub: user.id, email: user.email, sessionVersion: user.sessionVersion });
  // TS-164: the new account is signed in straight away, and asked to confirm its email address.
  // TS-220: the account is made by now, so its confirmation email is best effort. The counters
  // failing (the database busy) used to turn a made account into a 500 with no sign-in -- and
  // trying again then said "An account with that email already exists". Now it's still a 201,
  // signed in, just without the email; the banner offers "Resend link".
  const verificationEmailSent = await sendFirstConfirmationEmail(req, user);

  const response = NextResponse.json(
    {
      user: { id: user.id, name: user.name, email: user.email, emailVerified: false },
      ...(wantsBearerToken(req) ? { token } : {}),
      verificationEmailSent,
    },
    { status: 201 }
  );
  setAuthCookie(response, token);
  return response;
}
