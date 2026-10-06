import { runningOnNetlify } from "@seatwise/shared";

// TS-148: whether the test-only "add a collaborator directly" endpoint is switched on. Never on the
// live site (a production build without the CI flag), so real people only get access by accepting
// an invite.
// TS-183: and never on Netlify at all, even if the CI flag were copied into the site's environment
// by mistake.
// TS-200: "on Netlify" is the same check the rest of the app uses (runningOnNetlify in
// packages/shared/src/netlify.ts) -- NETLIFY, or the variables Netlify sets at runtime, since
// NETLIFY isn't always present inside a deployed function (TS-192).
export function directCollaboratorAddAllowed(env: Record<string, string | undefined>): boolean {
  if (runningOnNetlify(env)) return false;
  return env.NODE_ENV !== "production" || env.ALLOW_DIRECT_COLLABORATOR_ADD === "1";
}
