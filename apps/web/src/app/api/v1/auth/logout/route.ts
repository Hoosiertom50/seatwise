import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bumpSessionVersion, revokeSession } from "@seatwise/db";
import { AUTH_COOKIE_NAME, AUTH_TOKEN_TTL_SECONDS, isSecureCookieContext } from "@/lib/auth";
import { revokedSessionKeepUntil } from "@/lib/session-renewal";
import { getAuthSession } from "@/lib/session";
import { readJson, zodErrorResponse } from "@/lib/api-response";

// TS-204: { everywhere: true } is "Log out on all devices"; no body (or false) is "Log out" here.
const logoutSchema = z.object({ everywhere: z.boolean().optional() }).strict();

// Clears the web app's httpOnly cookie server-side, and ends the session itself, so a copy of the
// token (a shared computer, a token a native client stored) stops working too, rather than staying
// valid until it expires.
// TS-204 (Tom's decision): "Log out" ends only this device's session (its id is recorded as ended,
// see revokeSession); signing out on a phone no longer signs the laptop out. "Log out on all
// devices" ends every session of the account, as TS-155's log out used to (the session version
// moves on). A token from before sessions had their own ids can't be ended on its own, so logging
// out with one ends every session, as before. The mobile app's Bearer tokens work the same way.
export async function POST(req: NextRequest) {
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = logoutSchema.safeParse(json.body ?? {});
  if (!parsed.success) return zodErrorResponse(parsed.error);
  const everywhere = parsed.data.everywhere === true;

  const session = await getAuthSession(req);
  if (session.user) {
    if (everywhere || !session.token.sessionId) {
      await bumpSessionVersion(session.user.id);
    } else {
      // TS-204: kept until no token of this session (renewed copies included) can still be valid.
      const keepUntil = revokedSessionKeepUntil(session.token, AUTH_TOKEN_TTL_SECONDS);
      await revokeSession(session.token.sessionId, session.user.id, new Date(keepUntil * 1000));
    }
  }
  const response = NextResponse.json({ ok: true, everywhere });
  // TS-65: this clearing Set-Cookie must mirror the same httpOnly/secure/sameSite attributes
  // used when the cookie was set at login/signup. Per RFC 6265 a cookie is keyed by
  // name+domain+path only, so an attribute-mismatched clear is spec-legal -- Chromium, Firefox,
  // and Edge all honor it regardless -- but WebKit's cookie store only clears the cookie when
  // the attributes match the original Set-Cookie.
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isSecureCookieContext(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
