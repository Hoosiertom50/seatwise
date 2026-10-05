import type { NextConfig } from "next";

// TS-130: standard security headers on every response, page or API. Netlify already adds HSTS in
// production; these cover the rest.
// - Framing is refused both ways (X-Frame-Options for older browsers, CSP frame-ancestors for
//   current ones), so no other site can load Seatwise in a hidden frame and trick a signed-in
//   planner into clicking Remove or Approve. The CSP carries *only* frame-ancestors, so it can't
//   break any script or style.
// - Referrer-Policy keeps RSVP and invite URLs, whose paths carry tokens, from being sent in full
//   to any other site a page links to.
// - Permissions-Policy turns off device features Seatwise never uses.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  // TS-172: plus three directives that can't break any script or style -- no plugins, no changing
  // the page's base URL, and forms only submit to Seatwise itself.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  // TS-130: don't advertise the framework (and so its version family) on every response.
  poweredByHeader: false,
  // TS-158: the PDF exports read their font files at runtime, so ship them with those routes.
  outputFileTracingIncludes: {
    "/api/v1/weddings/*/plan-versions/*/export/*": ["./fonts/**/*"],
  },
  async headers() {
    // TS-172: private links (guest RSVP, vendor view, invites, password reset, email confirmation)
    // are never to be indexed or followed by search engines.
    const noIndex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      ...["/rsvp/:path*", "/vendor/:path*", "/invites/:path*", "/reset-password/:path*", "/verify-email/:path*"].map((source) => ({
        source,
        headers: noIndex,
      })),
    ];
  },
};

export default nextConfig;
