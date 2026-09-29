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
  // /api/v1/auth/* issues or clears the session itself -- a renewal cookie added here would race the
  // route's own Set-Cookie (and on logout, resurrect the session being cleared).
  if (req.nextUrl.pathname.startsWith("/api/v1/auth/")) return NextResponse.next();

  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  const token = bearer ?? req.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return NextResponse.next();

  const claims = await verifyToken(token);
  if (!claims || !shouldRenew(claims, Math.floor(Date.now() / 1000))) return NextResponse.next();

  const renewed = await signToken({ sub: claims.sub, email: claims.email, authTime: claims.authTime });
  const response = NextResponse.next();
  if (bearer) response.headers.set(RENEWED_TOKEN_HEADER, renewed);
  else setAuthCookie(response, renewed);
  return response;
}

export const config = {
  matcher: "/api/v1/:path*",
};
