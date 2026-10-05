import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, setAuthCookie, signToken, verifyToken } from "@/lib/auth";
import { RENEWED_TOKEN_HEADER, shouldRenew } from "@/lib/session-renewal";

// TS-94: sliding session renewal. Runs ahead of every /api/v1 request; when the caller's token is
// valid but old enough (see session-renewal.ts), the response carries a freshly issued one -- as a
// refreshed cookie for the web app, or a response header for a Bearer client (the mobile app). A
// planner actively using Seatwise therefore never reaches the token's expiry.
//
// Never touches authentication itself: every route still calls getAuthUser, which re-verifies the
// token and re-checks the user exists. This only ever *extends* a session that is already valid.
export async function proxy(req: NextRequest) {
  const refused = refuseCrossSiteWrite(req);
  if (refused) return refused;

  // /api/v1/auth/* issues or clears the session itself -- a renewal cookie added here would race the
  // route's own Set-Cookie (and on logout, resurrect the session being cleared).
  if (req.nextUrl.pathname.startsWith("/api/v1/auth/")) return NextResponse.next();

  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  const token = bearer ?? req.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return NextResponse.next();

  const claims = await verifyToken(token);
  if (!claims || !shouldRenew(claims, Math.floor(Date.now() / 1000))) return NextResponse.next();

  const renewed = await signToken({
    sub: claims.sub,
    email: claims.email,
    authTime: claims.authTime,
    sessionVersion: claims.sessionVersion,
  });
  const response = NextResponse.next();
  if (bearer) response.headers.set(RENEWED_TOKEN_HEADER, renewed);
  else setAuthCookie(response, renewed);
  return response;
}

// TS-155: the session cookie is SameSite=Lax, which already keeps it off cross-site POSTs -- but a
// sign-in, log out or password reset doesn't need the cookie to do harm (another site could sign a
// visitor into an account it controls). So a write must be JSON (an HTML form on another site can
// only send form or plain-text bodies, and JSON from another site's script needs a CORS approval
// Seatwise never gives), and must not be marked cross-site by the browser.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function refuseCrossSiteWrite(req: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(req.method)) return null;
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Requests from other sites aren't accepted." }, { status: 403 });
  }
  const type = req.headers.get("content-type");
  // TS-172: a request with a body must say it's JSON. One with no Content-Type at all used to get
  // through -- and a cross-site "no-cors" request can send a body without one, which (in browsers
  // that don't send Sec-Fetch-Site) the routes would still have read as JSON. A write with no body
  // (Generate, log out) needs no type.
  const hasBody = Number(req.headers.get("content-length") ?? "0") > 0 || req.headers.has("transfer-encoding");
  if ((type && !type.toLowerCase().startsWith("application/json")) || (!type && hasBody)) {
    return NextResponse.json({ error: "Send this request as JSON." }, { status: 415 });
  }
  return null;
}

export const config = {
  matcher: "/api/v1/:path*",
};
