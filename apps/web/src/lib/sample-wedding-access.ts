// TS-272: who may use the team's "Add a sample wedding" button. Only signed-in accounts whose
// confirmed email is on one of the domains in SAMPLE_WEDDING_EMAIL_DOMAINS (comma-separated, set
// on the live site in Netlify, never in this public repo). Unset or blank: off for everyone.
// Each domain must match the whole part after the "@" -- "x@sub.team.com" or "x@team.com.evil" is
// not on "team.com" -- and the check is the same for the button and the server.

/** The domains in the setting, lower-cased, without a leading "@"; empty when the feature is off. */
export function sampleWeddingDomains(env: Record<string, string | undefined>): string[] {
  return (env.SAMPLE_WEDDING_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0 && !d.includes("@"));
}

export function mayAddSampleWedding(
  user: { email: string; emailVerifiedAt: Date | null } | null,
  env: Record<string, string | undefined>
): boolean {
  if (!user || user.emailVerifiedAt === null) return false;
  const domains = sampleWeddingDomains(env);
  if (domains.length === 0) return false;
  const at = user.email.lastIndexOf("@");
  if (at < 1) return false;
  return domains.includes(user.email.slice(at + 1).trim().toLowerCase());
}
