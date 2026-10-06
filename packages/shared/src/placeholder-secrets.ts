// TS-192: values that must never be used as a real JWT_SECRET or ENCRYPTION_KEY in production.
// Anyone who has read this public repo knows them: the .env.example value, the README's stand-ins,
// the development-only encryption key from packages/db/src/crypto.ts, and the obvious "changeme"
// style guesses. One list, used by both checks (apps/web/src/lib/auth.ts and
// packages/db/src/crypto.ts), so a new stand-in only has to be added here.

/** The development-only encryption key (packages/db/src/crypto.ts) -- published, so never real. */
export const DEV_ONLY_ENCRYPTION_KEY = "dev-only-encryption-key-change-in-production-9d2f7a1c";

export const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  // .env.example
  "replace-with-a-long-random-secret",
  // README
  "a long random string",
  "a different long random string",
  // packages/db/src/crypto.ts
  DEV_ONLY_ENCRYPTION_KEY,
  // obvious stand-ins
  "changeme",
  "change-me",
  "change_me",
  "secret",
  "password",
  "test",
  "example",
  "placeholder",
]);

/** True when the value (ignoring surrounding spaces and letter case) is one of the known stand-ins. */
export function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_SECRETS.has(value.trim().toLowerCase());
}
