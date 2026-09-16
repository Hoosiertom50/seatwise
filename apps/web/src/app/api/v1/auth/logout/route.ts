import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, isSecureCookieContext } from "@/lib/auth";

// Native clients don't need this — they just discard the token locally. It exists so the
// web app can clear its httpOnly cookie server-side.
export async function POST() {
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
