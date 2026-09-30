/**
 * TS-130 (REQ-NON-FUNCTIONAL, REQ-ACCESS-CONTROL) — every response, page or API, refuses to be
 * framed by another site (X-Frame-Options and CSP frame-ancestors -- clickjacking), limits the
 * referrer sent elsewhere (RSVP and invite paths carry tokens), turns off unused device features,
 * and doesn't advertise the framework. Found by the first public check of the live site.
 *
 * Genuinely read-only: no account, no data -- a signed-out page load and a signed-out API call.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";

const EXPECTED: Record<string, string> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-content-type-options": "nosniff",
};

defineQualityTest(
  {
    id: "non-functional.every-response-carries-security-headers.page-and-api",
    title: "every page and API response refuses framing, limits the referrer, disables unused device features, and doesn't advertise the framework",
    objective:
      "Confirms that a page (/login) and an API route (/api/v1/auth/me, signed out) both carry X-Frame-Options DENY, CSP frame-ancestors 'none', Referrer-Policy strict-origin-when-cross-origin, a Permissions-Policy disabling camera/microphone/geolocation, and X-Content-Type-Options nosniff, and that neither sends an x-powered-by header.",
    expectedOutcome:
      "Both responses carry all five headers with exactly the expected values, and neither has x-powered-by.",
    requirementIds: ["REQ-NON-FUNCTIONAL", "REQ-ACCESS-CONTROL"],
    tags: ["@readonly", "@feature:non-functional", "@risk:high", "@suite:regression"],
  },
  async ({ request }) => {
    for (const path of ["/login", "/api/v1/auth/me"]) {
      await test.step(`${path} carries the security headers and no x-powered-by`, async () => {
        const res = await request.get(path);
        const headers = res.headers();
        for (const [key, value] of Object.entries(EXPECTED)) {
          expect(headers[key], `${path}: ${key}`).toBe(value);
        }
        expect(headers["x-powered-by"], `${path}: x-powered-by`).toBeUndefined();
      });
    }
  },
);
