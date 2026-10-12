import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { DEV_ONLY_ENCRYPTION_KEY, isPlaceholderSecret } from "@seatwise/shared";

// NFR-9.3b: guest personal data — specifically the free-text notes field, where dietary and
// accessibility details actually live — is encrypted at rest, not just relied on to sit behind a
// permission check. This is app-level field encryption (AES-256-GCM) rather than whole-disk/
// column-level database encryption: it works the same regardless of how or where the database
// ends up hosted, and it means a raw database dump or backup never contains this data in the
// clear. Encryption in transit (TLS) and disk-level database encryption are a deployment/hosting
// concern rather than application code — see the README's NFR-9.3b note for what's expected there.
//
// ENCRYPTION_KEY must be a long random secret in any real deployment (set via the environment,
// same as JWT_SECRET). Outside production it falls back to a fixed dev-only key, so local
// development and the test suite work without extra setup.
//
// TS-127: in production there is no fallback. A deployment missing the key used to run normally
// and quietly encrypt every guest note with the dev key above -- which is published in this file
// -- and adding the real key later would then have made all of those notes unreadable. Now any
// encrypt/decrypt in production without a real key (32+ characters) throws, so the mistake is
// loud and immediate. The key is read on first use rather than at import, so `next build` (which
// imports server code) doesn't need the secret. It must never change once real data exists: a
// lost or changed key leaves every note saved so far unreadable.
// TS-192: the key itself lives in @seatwise/shared next to the other known placeholders, so the
// production check below (and the JWT_SECRET check) can refuse it by name.
const DEV_ONLY_KEY = DEV_ONLY_ENCRYPTION_KEY;
const MIN_KEY_LENGTH = 32;

let cached: { source: string; key: Buffer } | null = null;

/**
 * TS-192: why this ENCRYPTION_KEY can't be used, or null if it's fine. In production a missing or
 * short key is refused (TS-127), and so is a known placeholder -- the .env.example value, the
 * README's stand-ins or the published development key -- which would otherwise pass the length
 * check and encrypt real guest notes with a key everyone can read.
 */
export function encryptionKeyProblem(key: string | undefined, nodeEnv: string | undefined): string | null {
  if (nodeEnv !== "production") return null;
  if (!key) return "ENCRYPTION_KEY is not set -- refusing to encrypt guest notes with the development key in production.";
  if (isPlaceholderSecret(key)) {
    return "ENCRYPTION_KEY is still a placeholder value -- refusing to encrypt guest notes with it. Set it to a long random value (e.g. openssl rand -hex 32).";
  }
  if (key.length < MIN_KEY_LENGTH) {
    return `ENCRYPTION_KEY is too short (needs at least ${MIN_KEY_LENGTH} characters) -- refusing to encrypt guest notes with it.`;
  }
  return null;
}

function encryptionKey(): Buffer {
  const configured = process.env.ENCRYPTION_KEY;
  const problem = encryptionKeyProblem(configured, process.env.NODE_ENV);
  if (problem) throw new Error(problem);
  const source = configured || DEV_ONLY_KEY;
  if (cached?.source !== source) cached = { source, key: keyFromSecret(source) };
  return cached.key;
}

const PREFIX = "enc:v1:";

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptText(plain: string | null | undefined): string | null {
  return encryptWithKey(plain, encryptionKey());
}

// TS-144: explicit-key versions, for moving notes between environments that use different
// ENCRYPTION_KEYs (local dev -> production). Same format as encryptText/decryptText.
export function encryptTextWithSecret(plain: string | null | undefined, secret: string): string | null {
  return encryptWithKey(plain, keyFromSecret(secret));
}

export function decryptTextWithSecret(stored: string | null | undefined, secret: string): string | null {
  return decryptWithKey(stored, keyFromSecret(secret));
}

/** The key local development uses when ENCRYPTION_KEY isn't set (never valid in production). */
export function devEncryptionSecret(): string {
  return DEV_ONLY_KEY;
}

function encryptWithKey(plain: string | null | undefined, key: Buffer): string | null {
  if (plain === null || plain === undefined) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptText(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  // Outside decryptWithKey's try: a missing production key must fail loudly, not read as
  // "[unable to decrypt]" for every guest.
  return decryptWithKey(stored, encryptionKey());
}

function decryptWithKey(stored: string | null | undefined, key: Buffer): string | null {
  if (stored === null || stored === undefined) return null;
  if (!stored.startsWith(PREFIX)) {
    // Not our encrypted format — treat as plaintext rather than throwing, so pre-existing rows
    // (or anything written before this migration) still read back instead of breaking the app.
    return stored;
  }
  try {
    const [ivB64, authTagB64, dataB64] = stored.slice(PREFIX.length).split(":");
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const ciphertext = Buffer.from(dataB64, "base64");
    // TS-149: only full 16-byte tags (what encryptText writes) are accepted.
    if (authTag.length !== 16) throw new Error("bad tag length");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // Corrupted or key-mismatched ciphertext — fail safe by hiding it rather than crashing the
    // whole guest list.
    return "[unable to decrypt]";
  }
}
