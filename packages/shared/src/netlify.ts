// TS-200: the one answer to "is this running on Netlify?" -- used by the app's own address
// (apps/web/src/lib/app-url.ts), the test-only direct collaborator add (apps/web/src/lib/direct-add.ts)
// and the email "log" transport (packages/db/src/email.ts). Each used to ask in its own way, with
// slightly different lists of variables.
//
// Netlify sets NETLIFY on builds, but it isn't always there inside a deployed function (TS-192), so
// the variables Netlify sets at runtime count too: CONTEXT, SITE_ID, DEPLOY_ID, and URL when it's a
// Netlify address (URL is a common name, so on its own it only counts when it ends in netlify.app
// or netlify.com -- a site on its own domain still has SITE_ID and DEPLOY_ID). `netlify dev`
// (NETLIFY_DEV) runs on this machine, so it doesn't count.

type Env = Record<string, string | undefined>;

function isNetlifyAddress(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return /(^|\.)netlify\.(app|com)$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** TS-200: true when running on Netlify (a build or a deployed function), not `netlify dev`. */
export function runningOnNetlify(env: Env): boolean {
  if (env.NETLIFY_DEV) return false;
  return Boolean(env.NETLIFY || env.CONTEXT || env.SITE_ID || env.DEPLOY_ID || isNetlifyAddress(env.URL));
}
