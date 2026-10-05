import { NextRequest, NextResponse } from "next/server";
import { bumpSessionVersion } from "@seatwise/db";
import { AUTH_COOKIE_NAME, isSecureCookieContext } from "@/lib/auth";
import { getAuthUser } from "@/lib/session";

// Clears the web app's httpOnly cookie server-side. TS-155: also ends the session itself -- and
// every other session of this account -- so a copy of the token (a shared computer, a token a
// native client stored) stops working too, rather than staying valid until it expires.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (user) await bumpSessionVersion(user.id);
  const response = NextResponse.json({ ok: true });
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
