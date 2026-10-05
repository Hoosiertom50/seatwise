// TS-174: one-off (and safely repeatable) -- encrypts the RSVP links and vendor share links that
// were made before TS-160 and are still stored in plain text.
//
// TS-160 moved link lookups to a hash ("rsvpTokenHash" / "shareTokenHash") and keeps an encrypted
// copy in "rsvpToken" / "shareToken" so the planner's "RSVP link" / "Share link" buttons can show
// the same link again. Links made before it are encrypted the next time one of those buttons
// reads them -- so a link nobody has opened since stays in plain text. This does them all now.
//
// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------
//
//   1. THE LINK KEEPS WORKING. Only the stored copy changes (plain text -> encrypted); the hash the
//      link is looked up by is left alone (or filled in, if it's somehow missing). The column is
//      never set to null: ensureGuestRsvpToken would then mint a brand-new link, and the one the
//      guest already has would stop working.
//
//   2. SAME KEY AS THE WEB APP. The copy has to be readable by the app that shows it, so it's
//      encrypted with the web app's key -- LINK_ENCRYPTION_KEY if set, else ENCRYPTION_KEY from
//      apps/web/.env, else this process's ENCRYPTION_KEY, else the development key (the same order
//      copy-weddings-to-production uses). Every value is decrypted again and compared before it's
//      written, and each row is only updated if it still holds the plain value read (a planner
//      regenerating the link meanwhile wins).
//
//   3. DRY RUN BY DEFAULT. Nothing is written without --confirm. Link values are never printed.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db encrypt-old-link-tokens            # dry run, prints counts
//   pnpm --filter @seatwise/db encrypt-old-link-tokens --confirm  # actually encrypts

// TS-172: local databases only (see local-only.ts).
import "./local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool, hashLinkToken } from "../src/index";
import { decryptTextWithSecret, devEncryptionSecret, encryptTextWithSecret } from "../src/crypto";
import { isPlainStoredLinkToken } from "../src/link-tokens";

function webAppEncryptionSecret(): string {
  if (process.env.LINK_ENCRYPTION_KEY) return process.env.LINK_ENCRYPTION_KEY;
  try {
    const line = readFileSync(path.join(__dirname, "..", "..", "..", "apps", "web", ".env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("ENCRYPTION_KEY="));
    const value = line?.slice("ENCRYPTION_KEY=".length).trim().replace(/^"|"$/g, "");
    if (value) return value;
  } catch {
    // no apps/web/.env -- fall through
  }
  return process.env.ENCRYPTION_KEY || devEncryptionSecret();
}

interface LinkTable {
  label: string;
  table: "guests" | "vendors";
  tokenColumn: "rsvpToken" | "shareToken";
  hashColumn: "rsvpTokenHash" | "shareTokenHash";
}

const LINK_TABLES: LinkTable[] = [
  { label: "guest RSVP links", table: "guests", tokenColumn: "rsvpToken", hashColumn: "rsvpTokenHash" },
  { label: "vendor share links", table: "vendors", tokenColumn: "shareToken", hashColumn: "shareTokenHash" },
];

async function encryptTable(t: LinkTable, secret: string, confirmed: boolean): Promise<void> {
  const { rows } = await pool.query<{ id: string; stored: string; hash: string | null }>(
    `SELECT id, "${t.tokenColumn}" AS stored, "${t.hashColumn}" AS hash FROM "${t.table}"
      WHERE "${t.tokenColumn}" IS NOT NULL AND "${t.tokenColumn}" NOT LIKE 'enc:v1:%'`,
  );
  const plain = rows.filter((r) => isPlainStoredLinkToken(r.stored));
  const missingHash = plain.filter((r) => r.hash === null).length;
  // A hash that doesn't match the plain copy means the two disagree about which link is live --
  // left alone and reported, never guessed at.
  const mismatched = plain.filter((r) => r.hash !== null && r.hash !== hashLinkToken(r.stored));
  const toEncrypt = plain.filter((r) => !mismatched.includes(r));

  console.log(`\n${t.label}: ${toEncrypt.length} stored in plain text${missingHash ? ` (${missingHash} also missing their hash)` : ""}.`);
  if (mismatched.length > 0) {
    console.log(`  Skipping ${mismatched.length} whose stored hash doesn't match (ids: ${mismatched.map((r) => r.id).join(", ")}).`);
  }
  if (!confirmed || toEncrypt.length === 0) return;

  let updated = 0;
  for (const r of toEncrypt) {
    const encrypted = encryptTextWithSecret(r.stored, secret)!;
    if (decryptTextWithSecret(encrypted, secret) !== r.stored) {
      throw new Error(`Encrypting ${t.table} ${r.id} didn't read back the same -- stopping (rows so far are fine).`);
    }
    const { rowCount } = await pool.query(
      `UPDATE "${t.table}" SET "${t.tokenColumn}" = $1, "${t.hashColumn}" = COALESCE("${t.hashColumn}", $2)
        WHERE id = $3 AND "${t.tokenColumn}" = $4`,
      [encrypted, hashLinkToken(r.stored), r.id, r.stored],
    );
    updated += rowCount ?? 0;
  }
  console.log(`  Encrypted ${updated} (${toEncrypt.length - updated} changed meanwhile and were left as they are).`);
}

async function main() {
  const confirmed = process.argv.includes("--confirm");
  const secret = webAppEncryptionSecret();
  if (secret === devEncryptionSecret()) {
    console.log("Using the development encryption key (no LINK_ENCRYPTION_KEY or ENCRYPTION_KEY found).");
  }

  for (const t of LINK_TABLES) await encryptTable(t, secret, confirmed);

  if (!confirmed) {
    console.log("\nDry run only -- nothing was written. Re-run with --confirm to encrypt these.");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  void pool.end();
});
