// TS-178: the one place the app's own address comes from -- every emailed or shared link (invites,
// RSVP and vendor links, password resets, email confirmations) and the session cookie's Secure
// flag use it. It used to be worked out separately in each of those places, each quietly falling
// back to http://localhost:3000; on the live site that would email people links that can't work.
//
// Locally (development and tests) the fallback stays. In a production build APP_URL must be the
// site's own https:// address -- or an http:// one on this machine (localhost), for a production
// build run locally. The one exception: with EMAIL_TRANSPORT=log (CI's e2e jobs) nothing is really
// emailed, so the local fallback is allowed there too.
//
// TS-192: on Netlify neither allowance applies. A copied EMAIL_TRANSPORT=log or a leftover
// http://localhost APP_URL in the site's settings would otherwise be accepted there, and every
// link and the session cookie would be built for the wrong address. Netlify always sets at least
// one of NETLIFY, CONTEXT, SITE_ID or DEPLOY_ID; `netlify dev` (NETLIFY_DEV) runs on this machine
// and keeps the local rules. (TS-200: see runningOnNetlify in packages/shared/src/netlify.ts.)

import { runningOnNetlify } from "@seatwise/shared";

type Env = Record<string, string | undefined>;

const LOCAL_FALLBACK = "http://localhost:3000";

export class AppUrlNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`APP_URL ${reason}: set it to the site's own https:// address.`);
    this.name = "AppUrlNotConfiguredError";
  }
}

// TS-200: "on Netlify" is decided in one place for the whole app (runningOnNetlify, @seatwise/shared).
export { runningOnNetlify };

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** The app's own address, without a trailing slash. Throws AppUrlNotConfiguredError in a
 * production build when APP_URL is missing or isn't https:// (see above). */
export function appBaseUrl(env: Env = process.env): string {
  const configured = env.APP_URL?.trim().replace(/\/+$/, "");
  const onNetlify = runningOnNetlify(env);
  if (env.NODE_ENV !== "production" && !onNetlify) return configured || LOCAL_FALLBACK;
  if (!configured) {
    if (env.EMAIL_TRANSPORT === "log" && !onNetlify) return LOCAL_FALLBACK;
    throw new AppUrlNotConfiguredError("is not set");
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new AppUrlNotConfiguredError("is not a web address");
  }
  if (url.protocol === "https:" && !(onNetlify && isLocalHost(url.hostname))) return configured;
  if (url.protocol === "http:" && isLocalHost(url.hostname) && !onNetlify) return configured;
  throw new AppUrlNotConfiguredError(onNetlify ? "is not the site's own https:// address (running on Netlify)" : "is not an https:// address");
}
