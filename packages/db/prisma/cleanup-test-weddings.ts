// One-off cleanup script written after `fill-existing-weddings.ts` was accidentally run against
// every wedding in the local dev database (559 of them -- almost all leftover Playwright
// E2E-fixture weddings that tests never cleaned up) instead of just the two real weddings on
// Tom's own account. See fill-existing-weddings.ts for the script that caused this.
//
// TS-172: it now deletes ONLY test data -- weddings whose name carries the Playwright marker
// ("pwqa-fixture") or that are owned by a test account (@example.invalid). It used to delete every
// wedding except two hard-coded ids, which would have wiped every real wedding made since (and,
// pointed at the live database, every couple's wedding). It also refuses to run against anything
// but a local database (local-only.ts).
//
// Previously: this deleted every wedding EXCEPT the two explicitly kept below. Because every row that
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
// TS-172: local databases only (see local-only.ts).
import "./local-only";
import { pool } from "../src/index";

// TS-172: what counts as test data -- the same rules the e2e teardown sweep uses.
const TEST_DATA_MARKER = "pwqa-fixture";
const TEST_ACCOUNT_DOMAIN = "%@example.invalid";
const IS_TEST_WEDDING = `(w.name LIKE '%' || $1 || '%' OR u.email LIKE $2)`;

interface WeddingRow {
  id: string;
  name: string;
  createdAt: Date;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");

  const { rows: toDelete } = await pool.query<WeddingRow>(
    `SELECT w.id, w.name, w."createdAt" FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE ${IS_TEST_WEDDING} ORDER BY w."createdAt"`,
    [TEST_DATA_MARKER, TEST_ACCOUNT_DOMAIN],
  );

  const { rows: kept } = await pool.query<WeddingRow>(
    `SELECT w.id, w.name, w."createdAt" FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
     WHERE NOT ${IS_TEST_WEDDING}`,
    [TEST_DATA_MARKER, TEST_ACCOUNT_DOMAIN],
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
