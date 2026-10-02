// TS-148: whether the test-only "add a collaborator directly" endpoint is switched on. Never on the
// live site (a production build without the CI flag), so real people only get access by accepting
// an invite.
export function directCollaboratorAddAllowed(env: { NODE_ENV?: string; ALLOW_DIRECT_COLLABORATOR_ADD?: string }): boolean {
  return env.NODE_ENV !== "production" || env.ALLOW_DIRECT_COLLABORATOR_ADD === "1";
}
