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

// TS-204: invisible characters a copy and paste can carry along (zero-width spaces and joiners,
// the byte-order mark, no-break and other unusual spaces).
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00a0, 0x00a0], [0x00ad, 0x00ad], [0x180e, 0x180e], [0x2000, 0x200f], [0x2028, 0x202f],
  [0x205f, 0x2064], [0x3000, 0x3000], [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`,
  "g"
);

/**
 * TS-204: the value as it would be pasted by mistake into a hosting dashboard, tidied the way a
 * person reading it would: invisible characters removed, a leading `export` and `NAME=` (a whole
 * .env line pasted as the value) dropped, surrounding quotes and spaces removed, lower case.
 */
export function normalizeSecretForCheck(value: string): string {
  return unwrapSecret(value).toLowerCase();
}

/**
 * The secret as it would be used once copy-paste extras are taken off (invisible characters, an
 * `export`/`NAME=` prefix, surrounding quotes) -- letter case kept, since a real key is
 * case-sensitive (Copilot review: an upper- and lower-case version of a key are different keys).
 */
export function unwrapSecret(value: string): string {
  let v = value.replace(INVISIBLE, "").trim();
  // An environment variable's name: capitals with an underscore (JWT_SECRET=, ENCRYPTION_KEY=).
  // Never matches a random hex or base64 value, whose trailing "=" padding must stay.
  v = v.replace(/^export\s+/i, "").replace(/^[A-Z][A-Z0-9]*_[A-Z0-9_]*\s*=\s*(?=\S)/, "");
  for (let i = 0; i < 3; i++) {
    const m = /^(["'`])([\s\S]*)\1$/.exec(v.trim());
    if (!m) break;
    v = m[2];
  }
  return v.trim();
}

/** TS-204: letters and digits only, so "Replace_With a long-random-secret" matches the list too. */
function lettersAndDigits(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// TS-204: stand-ins long enough that finding one inside a value means the value was built from it
// (a random value won't contain "replacewithalongrandomsecret" or "changeme" by chance). The short
// ones ("test", "secret", "example") count only as the whole value.
const COMPACT_PLACEHOLDERS = [...PLACEHOLDER_SECRETS].map(lettersAndDigits);
const CONTAINED_PLACEHOLDERS = COMPACT_PLACEHOLDERS.filter((p) => p.length >= 8);

/**
 * True when the value is one of the known stand-ins. TS-204: also when it's wrapped in quotes,
 * pasted as `NAME=value`, carries invisible characters or different separators, or contains one
 * of the longer stand-ins (e.g. "replace-with-a-long-random-secret-2").
 */
export function isPlaceholderSecret(value: string): boolean {
  const v = normalizeSecretForCheck(value);
  if (PLACEHOLDER_SECRETS.has(v)) return true;
  const compact = lettersAndDigits(v);
  if (COMPACT_PLACEHOLDERS.includes(compact)) return true;
  return CONTAINED_PLACEHOLDERS.some((p) => compact.includes(p));
}

/** TS-204: true when two secrets are the same value once copy-paste extras are taken off
 * (unwrapSecret) -- compared with letter case kept, as the keys themselves are. */
export function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return unwrapSecret(a) === unwrapSecret(b);
}
