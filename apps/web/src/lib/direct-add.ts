// TS-148: whether the test-only "add a collaborator directly" endpoint is switched on. Never on the
// live site (a production build without the CI flag), so real people only get access by accepting
// an invite.
// TS-183: and never on Netlify at all (NETLIFY is set on every Netlify build and function), even if
// the CI flag were copied into the site's environment by mistake.
export function directCollaboratorAddAllowed(env: {
  NODE_ENV?: string;
  ALLOW_DIRECT_COLLABORATOR_ADD?: string;
  NETLIFY?: string;
}): boolean {
  if (env.NETLIFY) return false;
  return env.NODE_ENV !== "production" || env.ALLOW_DIRECT_COLLABORATOR_ADD === "1";
}
