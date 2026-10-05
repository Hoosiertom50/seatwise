import { createHash, randomBytes } from "crypto";
import { decryptText, encryptText } from "./crypto";

// TS-160: guest RSVP links, vendor share links and collaborator invite links carry a 32-byte random
// token. The database looks a link up by a SHA-256 hash of its token, never the token itself, so a
// leaked dump or backup holds no working link. Guests and vendors also keep an encrypted copy so
// the planner's "RSVP link" / "Share link" buttons can show the current link again; invites keep
// only the hash (their link is emailed once). Same approach as password-reset links (TS-142).

/** The hash a link's token is stored and looked up by. */
export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh link token, its hash, and the encrypted copy kept for showing the link again. */
export function newLinkToken(): { token: string; hash: string; encrypted: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashLinkToken(token), encrypted: encryptText(token)! };
}

/** The token from its stored copy (older rows hold it in plain text; decryptText passes those through). */
export function readStoredLinkToken(stored: string | null | undefined): string | null {
  return decryptText(stored);
}

/** True for a stored copy written before TS-160 (plain text, to be encrypted on next read). */
export function isPlainStoredLinkToken(stored: string): boolean {
  return !stored.startsWith("enc:v1:");
}
