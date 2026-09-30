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
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  // TS-130: don't advertise the framework (and so its version family) on every response.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
