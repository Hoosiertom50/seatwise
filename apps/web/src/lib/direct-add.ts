import { mightBeHosted } from "@seatwise/shared";

// TS-148: whether the test-only "add a collaborator directly" endpoint is switched on. Never on the
// live site (a production build without the CI flag), so real people only get access by accepting
// an invite.
// TS-183: and never on Netlify at all, even if the CI flag were copied into the site's environment
// by mistake.
// TS-204: with the strict check (mightBeHosted in packages/shared/src/netlify.ts) -- URL set to
// anything, or NETLIFY_DEV, switches it off too. TS-200 had moved this onto runningOnNetlify,
// which only counts Netlify addresses and lets `netlify dev` through; that's right for choosing
// the app's own address, but too loose for a switch that must stay off on any hosted site.
export function directCollaboratorAddAllowed(env: Record<string, string | undefined>): boolean {
  if (mightBeHosted(env)) return false;
  return env.NODE_ENV !== "production" || env.ALLOW_DIRECT_COLLABORATOR_ADD === "1";
}
