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
//   4. TS-183: LOCAL ONLY, unless run with --target-production. Then it asks for the live site's
//      DATABASE_URL (PRODUCTION_DATABASE_URL) and its link-encryption key (PRODUCTION_ENCRYPTION_KEY
//      -- the live web app's ENCRYPTION_KEY), or reads them from the environment; neither is echoed
//      or printed (see production-target.ts). The development key and keys shorter than 32
//      characters are refused, and so is a key that can't read the links already encrypted there
//      (a wrong key would make every link the planner's buttons show unreadable).
//      TS-192: when no link is encrypted there yet, the key is checked against encrypted guest notes
//      instead (notes / rsvpNotes, encrypted with the same key). When nothing at all is encrypted
//      there, nothing can prove the key is right, so --confirm also asks for the key to be typed
//      twice more (not shown) and both must match -- a mistyped or wrong-site key would otherwise be
//      written into every link.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db encrypt-old-link-tokens            # dry run, prints counts
//   pnpm --filter @seatwise/db encrypt-old-link-tokens --confirm  # actually encrypts
// Against the live site (after the migrations are applied):
//   read -rs PRODUCTION_DATABASE_URL && read -rs PRODUCTION_ENCRYPTION_KEY && \
//     export PRODUCTION_DATABASE_URL PRODUCTION_ENCRYPTION_KEY
//   pnpm --filter @seatwise/db encrypt-old-link-tokens -- --target-production            # dry run
//   pnpm --filter @seatwise/db encrypt-old-link-tokens -- --target-production --confirm  # writes

// TS-172: local databases only (see local-only.ts) -- TS-183: unless --target-production.
import "./local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { decryptTextWithSecret, devEncryptionSecret, encryptTextWithSecret } from "../src/crypto";
import { isPlaceholderSecret } from "@seatwise/shared";
import { hashLinkToken, isPlainStoredLinkToken } from "../src/link-tokens";
import { askSecret, readSecret, targetsProduction, useProductionDatabase } from "./production-target";

// TS-183: loaded only once the target database is known (see main) -- importing it connects.
let pool: Pool;

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

// TS-183: every link already encrypted on the target must read back with this key and match its
// hash -- otherwise this key isn't the one the web app there uses. Returns how many were checked
// and how many didn't read.
async function checkKeyAgainstExistingLinks(secret: string): Promise<{ checked: number; unreadable: number }> {
  let checked = 0;
  let unreadable = 0;
  for (const t of LINK_TABLES) {
    const { rows } = await pool.query<{ stored: string; hash: string | null }>(
      `SELECT "${t.tokenColumn}" AS stored, "${t.hashColumn}" AS hash FROM "${t.table}" WHERE "${t.tokenColumn}" LIKE 'enc:v1:%'`,
    );
    for (const r of rows) {
      checked += 1;
      const plain = decryptTextWithSecret(r.stored, secret);
      if (!plain || plain === "[unable to decrypt]" || (r.hash !== null && hashLinkToken(plain) !== r.hash)) unreadable += 1;
    }
  }
  return { checked, unreadable };
}

// TS-192: the same check against encrypted guest notes, for a database with no encrypted link yet.
// A sample is enough: every note is encrypted with the one ENCRYPTION_KEY.
async function checkKeyAgainstGuestNotes(secret: string): Promise<{ checked: number; unreadable: number }> {
  const { rows } = await pool.query<{ notes: string | null; rsvpNotes: string | null }>(
    `SELECT notes, "rsvpNotes" FROM "guests" WHERE notes LIKE 'enc:v1:%' OR "rsvpNotes" LIKE 'enc:v1:%' LIMIT 200`,
  );
  let checked = 0;
  let unreadable = 0;
  for (const r of rows) {
    for (const stored of [r.notes, r.rsvpNotes]) {
      if (!stored?.startsWith("enc:v1:")) continue;
      checked += 1;
      if (decryptTextWithSecret(stored, secret) === "[unable to decrypt]") unreadable += 1;
    }
  }
  return { checked, unreadable };
}

async function main() {
  const confirmed = process.argv.includes("--confirm");
  const production = targetsProduction();
  let secret: string;
  if (production) {
    await useProductionDatabase();
    secret = await readSecret("PRODUCTION_ENCRYPTION_KEY", "Production ENCRYPTION_KEY (not shown): ");
    if (secret.length < 32) throw new Error("The production encryption key is shorter than 32 characters -- refusing.");
    if (secret === devEncryptionSecret()) throw new Error("That's the development key, not the live site's -- refusing.");
    // TS-192: and any other known placeholder (the .env.example value, the README's stand-ins).
    if (isPlaceholderSecret(secret)) throw new Error("That's a placeholder from the repo, not the live site's key -- refusing.");
  } else {
    secret = webAppEncryptionSecret();
    if (secret === devEncryptionSecret()) {
      console.log("Using the development encryption key (no LINK_ENCRYPTION_KEY or ENCRYPTION_KEY found).");
    }
  }
  ({ pool } = await import("../src/index"));

  let keyCheck = await checkKeyAgainstExistingLinks(secret);
  // TS-192: no encrypted link to check against -- use encrypted guest notes instead.
  if (keyCheck.checked === 0) {
    const noteCheck = await checkKeyAgainstGuestNotes(secret);
    if (noteCheck.checked > 0) {
      console.log(`No encrypted links yet -- checking the key against ${noteCheck.checked} encrypted guest note(s) instead.`);
      keyCheck = noteCheck;
    }
  }
  if (production && confirmed && keyCheck.checked === 0) {
    console.log("Nothing on the live site is encrypted yet, so nothing can prove this key is the web app's.");
    const first = await askSecret("Type the production ENCRYPTION_KEY again to confirm (not shown): ");
    const second = await askSecret("And once more (not shown): ");
    if (first !== secret || second !== secret) {
      throw new Error("The key typed didn't match the one given -- nothing was changed.");
    }
  }
  if (keyCheck.unreadable > 0) {
    const message = `${keyCheck.unreadable} of ${keyCheck.checked} already-encrypted value(s) can't be read with this key.`;
    if (production) throw new Error(`${message} It isn't the live web app's ENCRYPTION_KEY -- nothing was changed.`);
    console.log(`Warning: ${message} Check LINK_ENCRYPTION_KEY / apps/web/.env before using --confirm.`);
  } else if (keyCheck.checked > 0) {
    console.log(`Key check: all ${keyCheck.checked} already-encrypted value(s) read back correctly.`);
  }

  for (const t of LINK_TABLES) await encryptTable(t, secret, confirmed);

  if (!confirmed) {
    console.log("\nDry run only -- nothing was written. Re-run with --confirm to encrypt these.");
  }
  await pool.end();
}

main().catch((err) => {
  // TS-183: only the message -- an error object can carry connection details.
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  void pool?.end();
});
