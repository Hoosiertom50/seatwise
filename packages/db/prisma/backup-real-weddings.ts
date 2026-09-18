// Dumps Tom's two real weddings -- and every row that hangs off them -- to a timestamped JSON
// file, so there is a restore point before any bulk-delete work (TS-102's globalTeardown sweep)
// is developed against this same database.
//
// Read-only: this script never writes to the database.
//
// Why this exists: the TS-102 sweep is a bulk delete keyed on a name match, iterated against the
// same local DB that holds the two real weddings. `fill-existing-weddings.ts` in this directory
// is the precedent for what a wrong assumption costs there. This is the cheap insurance.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db backup-real-weddings

import "./load-env";
import { pool } from "../src/index";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const TARGET_WEDDING_IDS = [
  "5f384ca5-d27c-42d6-b971-4f1d4c0f0453", // "Jim and Melissa"
  "d95acaaa-1974-40c8-bdbf-f91b0c2794f6", // "Chris and Jill"
];

// Every table that holds rows belonging to a wedding, and how to reach that wedding from it.
// Ordered parent-first so the dump reads in dependency order.
const TABLES: Array<{ table: string; where: string }> = [
  { table: "weddings", where: `id = ANY($1::text[])` },
  { table: "guests", where: `"weddingId" = ANY($1::text[])` },
  { table: "guest_relationships", where: `"weddingId" = ANY($1::text[])` },
  { table: "seating_tables", where: `"weddingId" = ANY($1::text[])` },
  { table: "restricted_table_guests", where: `"tableId" IN (SELECT id FROM "seating_tables" WHERE "weddingId" = ANY($1::text[]))` },
  { table: "plan_versions", where: `"weddingId" = ANY($1::text[])` },
  { table: "seat_assignments", where: `"planVersionId" IN (SELECT id FROM "plan_versions" WHERE "weddingId" = ANY($1::text[]))` },
  { table: "change_history_entries", where: `"planVersionId" IN (SELECT id FROM "plan_versions" WHERE "weddingId" = ANY($1::text[]))` },
  { table: "rule_weight_configs", where: `"weddingId" = ANY($1::text[])` },
  { table: "timeline_entries", where: `"weddingId" = ANY($1::text[])` },
  { table: "vendors", where: `"weddingId" = ANY($1::text[])` },
  { table: "comments", where: `"weddingId" = ANY($1::text[])` },
  { table: "notifications", where: `"weddingId" = ANY($1::text[])` },
  { table: "wedding_collaborators", where: `"weddingId" = ANY($1::text[])` },
  { table: "wedding_invites", where: `"weddingId" = ANY($1::text[])` },
  { table: "seating_templates", where: `"sourceWeddingId" = ANY($1::text[])` },
];

async function main() {
  const dump: Record<string, unknown[]> = {};
  let grandTotal = 0;

  for (const { table, where } of TABLES) {
    // Table/where come from the fixed list above, never from input -- safe to interpolate.
    const { rows } = await pool.query(`SELECT * FROM "${table}" WHERE ${where}`, [TARGET_WEDDING_IDS]);
    dump[table] = rows;
    grandTotal += rows.length;
    if (rows.length > 0) console.log(`  ${table.padEnd(26)} ${rows.length}`);
  }

  if ((dump.weddings ?? []).length !== TARGET_WEDDING_IDS.length) {
    console.error(`\nABORT: expected ${TARGET_WEDDING_IDS.length} weddings, found ${(dump.weddings ?? []).length}. Not writing a partial backup.`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(__dirname, "..", "..", "..", "artifacts", "db-backups");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `real-weddings-${stamp}.json`);

  writeFileSync(
    file,
    JSON.stringify(
      { takenAt: new Date().toISOString(), weddingIds: TARGET_WEDDING_IDS, rowCount: grandTotal, tables: dump },
      null,
      2,
    ),
  );

  console.log(`\n${grandTotal} rows across ${TABLES.length} tables.`);
  console.log(`Written to: ${file}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  void pool.end();
});
