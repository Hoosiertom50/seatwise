// TS-148: whether the test-only "add a collaborator directly" endpoint is switched on. Never on the
// live site (a production build without the CI flag), so real people only get access by accepting
// an invite.
// TS-183: and never on Netlify at all (NETLIFY is set on every Netlify build and function), even if
// the CI flag were copied into the site's environment by mistake.
export function directCollaboratorAddAllowed(env: {
  NODE_ENV?: string;
  ALLOW_DIRECT_COLLABORATOR_ADD?: string;
  NETLIFY?: string;
  SITE_ID?: string;
  DEPLOY_ID?: string;
  URL?: string;
}): boolean {
  // TS-192: NETLIFY isn't always present inside a deployed function, so the variables Netlify sets
  // at runtime (SITE_ID, DEPLOY_ID, URL) count as "on Netlify" too.
  if (env.NETLIFY || env.SITE_ID || env.DEPLOY_ID || env.URL) return false;
  return env.NODE_ENV !== "production" || env.ALLOW_DIRECT_COLLABORATOR_ADD === "1";
}
