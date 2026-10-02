// TS-144: copies Tom's two local weddings -- "Jim and Melissa" and "Chris and Jill", with every row
// that hangs off them -- into an account on another Seatwise database (the live site).
//
// SAFETY -- read this before changing anything here:
//   * Copies ONLY the two wedding IDs below (the same pinned list as backup-real-weddings.ts).
//     It never derives its targets from the database.
//   * DRY RUN BY DEFAULT: prints what it would copy and writes nothing unless you pass --confirm.
//   * Refuses if either wedding already exists on the target, or if the target account doesn't.
//   * Writes everything in ONE transaction: a failure part-way leaves the target untouched.
//   * Guest notes are encrypted with different keys locally and on the live site, so they're
//     decrypted with the local key and re-encrypted with the target's. RSVP and vendor share
//     links are cleared (made fresh on the target when needed). Comments by anyone other than
//     the owner become "Former member" -- those accounts don't exist on the target.
//   * The target's connection string and ENCRYPTION_KEY are read from the environment, never
//     from arguments, and are never printed.
//
// Usage (from the repo root), entering the secrets so they're never shown or saved:
//   read -rs TARGET_DATABASE_URL && read -rs TARGET_ENCRYPTION_KEY && \
//     TARGET_DATABASE_URL="$TARGET_DATABASE_URL" TARGET_ENCRYPTION_KEY="$TARGET_ENCRYPTION_KEY" \
//     pnpm --filter @seatwise/db copy-weddings -- --owner tom.carter@e-gineering.com [--confirm]

import "./load-env";

import { Pool } from "pg";
import { pool as sourcePool } from "../src/index";
import { devEncryptionSecret } from "../src/crypto";
import { WEDDING_COPY_TABLES, transformRowForCopy } from "../src/wedding-copy";

const TARGET_WEDDING_IDS = [
  "5f384ca5-d27c-42d6-b971-4f1d4c0f0453", // "Jim and Melissa"
  "d95acaaa-1974-40c8-bdbf-f91b0c2794f6", // "Chris and Jill"
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const ownerEmail = arg("--owner")?.trim().toLowerCase();
  const targetUrl = process.env.TARGET_DATABASE_URL;
  const targetSecret = process.env.TARGET_ENCRYPTION_KEY;
  if (!ownerEmail) throw new Error("Pass --owner <email of the account on the target to copy into>.");
  if (!targetUrl) throw new Error("TARGET_DATABASE_URL is not set.");
  if (!targetSecret || targetSecret.length < 32) throw new Error("TARGET_ENCRYPTION_KEY is missing or shorter than 32 characters.");
  if (targetUrl === process.env.DATABASE_URL) throw new Error("The target is the same database as the source -- refusing.");
  const sourceSecret = process.env.ENCRYPTION_KEY || devEncryptionSecret();

  const target = new Pool({ connectionString: targetUrl, max: 1 });
  try {
    // --- Checks, before reading anything to copy.
    const { rows: weddings } = await sourcePool.query<{ id: string; name: string; ownerId: string }>(
      `SELECT id, name, "ownerId" FROM "weddings" WHERE id = ANY($1::text[])`,
      [TARGET_WEDDING_IDS]
    );
    if (weddings.length !== TARGET_WEDDING_IDS.length) {
      throw new Error(`Expected ${TARGET_WEDDING_IDS.length} weddings locally, found ${weddings.length}.`);
    }
    const sourceOwners = new Set(weddings.map((w) => w.ownerId));
    if (sourceOwners.size !== 1) throw new Error("The weddings don't share one owner locally -- refusing.");
    const sourceOwnerId = [...sourceOwners][0];

    const { rows: owners } = await target.query<{ id: string; name: string }>(
      `SELECT id, name FROM "users" WHERE email = $1`,
      [ownerEmail]
    );
    if (!owners[0]) throw new Error(`No account for ${ownerEmail} on the target. Sign up there first.`);
    const { rows: clash } = await target.query(`SELECT id FROM "weddings" WHERE id = ANY($1::text[])`, [TARGET_WEDDING_IDS]);
    if (clash.length > 0) throw new Error("These weddings are already on the target -- nothing copied.");

    // --- Read and transform.
    const options = { sourceOwnerId, targetOwnerId: owners[0].id, sourceSecret, targetSecret };
    const plan: { table: string; rows: Record<string, unknown>[] }[] = [];
    for (const { table, where, orderBy } of WEDDING_COPY_TABLES) {
      // table/where/orderBy come from the fixed list in wedding-copy.ts, never from input.
      const { rows } = await sourcePool.query(
        `SELECT * FROM "${table}" WHERE ${where}${orderBy ? ` ORDER BY ${orderBy}` : ""}`,
        [TARGET_WEDDING_IDS]
      );
      plan.push({ table, rows: rows.map((r) => transformRowForCopy(table, r, options)) });
    }

    console.log(`Copy into ${ownerEmail} (${owners[0].name}) on the target:`);
    for (const w of weddings) console.log(`  wedding: ${w.name}`);
    for (const { table, rows } of plan) if (rows.length) console.log(`  ${table.padEnd(26)} ${rows.length}`);
    const total = plan.reduce((n, p) => n + p.rows.length, 0);
    console.log(`  ${"total rows".padEnd(26)} ${total}`);

    if (!confirm) {
      console.log("\nDry run -- nothing written. Re-run with --confirm to copy.");
      return;
    }

    // --- Write, all or nothing.
    const client = await target.connect();
    try {
      await client.query("BEGIN");
      for (const { table, rows } of plan) {
        if (rows.length === 0) continue;
        const { rows: cols } = await client.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [table]
        );
        const targetColumns = new Set(cols.map((c) => c.column_name));
        const jsonColumns = new Set(cols.filter((c) => c.data_type === "json" || c.data_type === "jsonb").map((c) => c.column_name));
        const columns = Object.keys(rows[0]);
        const missing = columns.filter((c) => !targetColumns.has(c));
        if (missing.length) throw new Error(`The target's ${table} has no ${missing.join(", ")} -- run its migrations first.`);
        const columnList = columns.map((c) => `"${c}"`).join(", ");
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        for (const row of rows) {
          await client.query(
            `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`,
            // json/jsonb values go as JSON text (pg would otherwise send a JS array as a Postgres array).
            columns.map((c) => (jsonColumns.has(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]))
          );
        }
      }
      await client.query("COMMIT");
      console.log(`\nCopied ${total} rows. Both weddings are now in ${ownerEmail}'s dashboard.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await target.end();
    await sourcePool.end();
  }
}

main().catch((err) => {
  // Never print the error's full object: it can carry connection details.
  console.error(`\nNot copied: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
