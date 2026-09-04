import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// NFR-9.3b: guest personal data — specifically the free-text notes field, where dietary and
// accessibility details actually live — is encrypted at rest, not just relied on to sit behind a
// permission check. This is app-level field encryption (AES-256-GCM) rather than whole-disk/
// column-level database encryption: it works the same regardless of how or where the database
// ends up hosted, and it means a raw database dump or backup never contains this data in the
// clear. Encryption in transit (TLS) and disk-level database encryption are a deployment/hosting
// concern rather than application code — see the README's NFR-9.3b note for what's expected there.
//
// ENCRYPTION_KEY should be a long random secret in any real deployment (set via the environment,
// same as JWT_SECRET) — falling back to a fixed dev-only key here only so local development and
// the test suite work without extra setup.
const KEY = createHash("sha256")
  .update(process.env.ENCRYPTION_KEY || "dev-only-encryption-key-change-in-production-9d2f7a1c")
  .digest();

const PREFIX = "enc:v1:";

export function encryptText(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptText(stored: string | null | undefined): string | null {
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
    const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // Corrupted or key-mismatched ciphertext — fail safe by hiding it rather than crashing the
    // whole guest list.
    return "[unable to decrypt]";
  }
}
