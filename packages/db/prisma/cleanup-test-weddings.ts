// One-off cleanup script written after `fill-existing-weddings.ts` was accidentally run against
// every wedding in the local dev database (559 of them -- almost all leftover Playwright
// E2E-fixture weddings that tests never cleaned up) instead of just the two real weddings on
// Tom's own account. See fill-existing-weddings.ts for the script that caused this.
//
// This deletes every wedding EXCEPT the two explicitly kept below. Because every row that
// references a wedding (guests, guest_relationships, seating_tables, plan_versions,
// seat_assignments, change_history_entries, comments, notifications, timeline_entries,
// collaborators, invites) has `onDelete: Cascade` back to Wedding in schema.prisma, deleting the
// wedding row is enough -- nothing needs to be cleaned up table-by-table.
//
// Safety: this runs as a DRY RUN by default. It only prints what it *would* delete. Nothing is
// deleted unless you pass --confirm.
//
//   pnpm db:cleanup-test-weddings            # dry run, safe, prints a preview
//   pnpm db:cleanup-test-weddings --confirm  # actually deletes
import "./load-env";
import { pool } from "../src/index";

// Tom's two real weddings -- everything else in the dev DB is a leftover Playwright test fixture.
const KEEP_WEDDING_IDS = [
  "5f384ca5-d27c-42d6-b971-4f1d4c0f0453", // "Jim and Melissa"
  "d95acaaa-1974-40c8-bdbf-f91b0c2794f6", // "Chris and Jill"
];

interface WeddingRow {
  id: string;
  name: string;
  createdAt: Date;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");

  const { rows: toDelete } = await pool.query<WeddingRow>(
    `SELECT id, name, "createdAt" FROM "weddings" WHERE id != ALL($1::text[]) ORDER BY "createdAt"`,
    [KEEP_WEDDING_IDS],
  );

  const { rows: kept } = await pool.query<WeddingRow>(
    `SELECT id, name, "createdAt" FROM "weddings" WHERE id = ANY($1::text[])`,
    [KEEP_WEDDING_IDS],
  );

  console.log(`Weddings in DB: ${toDelete.length + kept.length} total.\n`);

  console.log(`Keeping ${kept.length} wedding(s):`);
  for (const w of kept) {
    console.log(`  KEEP "${w.name}" (${w.id})`);
  }
  console.log("");

  console.log(`${confirmed ? "Deleting" : "Would delete"} ${toDelete.length} wedding(s):`);
  const sampleSize = 15;
  for (const w of toDelete.slice(0, sampleSize)) {
    console.log(`  ${confirmed ? "DELETE" : "would delete"} "${w.name}" (${w.id})`);
  }
  if (toDelete.length > sampleSize) {
    console.log(`  ...and ${toDelete.length - sampleSize} more.`);
  }
  console.log("");

  if (!confirmed) {
    console.log("Dry run only -- nothing was deleted. Re-run with --confirm to actually delete these.");
    return;
  }

  if (toDelete.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  const idsToDelete = toDelete.map((w) => w.id);
  const { rowCount } = await pool.query(`DELETE FROM "weddings" WHERE id = ANY($1::text[])`, [idsToDelete]);
  console.log(`Deleted ${rowCount} wedding(s) (guests/tables/rules/plan versions cascade-deleted with them).`);

  const { rows: remaining } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text as count FROM "weddings"`);
  console.log(`\n${remaining[0].count} wedding(s) remain in the database.`);
}

main()
  .catch((err) => {
    console.error("cleanup-test-weddings failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
