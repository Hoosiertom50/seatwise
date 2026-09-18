// TS-103: deletes the user accounts this project's Playwright suite signs up.
//
// Every E2E test calls `signUpFreshAccount`, which creates a real user row, and the application
// exposes no account-deletion endpoint of any kind (see DEC-012 and `deleteUserAccount` in
// e2e/data/api.ts). Nothing could remove these, so they accumulated: 6,305 test accounts against
// 2 real ones when this script was written.
//
// ---------------------------------------------------------------------------
// SAFETY -- this is the most dangerous script in this directory. Read first.
// ---------------------------------------------------------------------------
//
// `User` is the ROOT of the cascade. `Wedding.ownerId` and `SeatingTemplate.ownerId` are both
// `onDelete: Cascade`, so deleting a user destroys their weddings, and with them every guest,
// table, plan version, seat assignment, comment, timeline entry and vendor beneath -- plus their
// templates. Deleting the wrong user is not a tidy-up, it is data loss.
//
// The single predicate is the reserved e-mail domain:
//
//   1. RESERVED-DOMAIN MATCH ONLY. An account qualifies only if its address ends in
//      `@example.invalid`. `.invalid` is the IANA-reserved TLD that is guaranteed never to resolve
//      or receive mail (RFC 2606) -- it is reserved precisely so that it cannot be a real address.
//      A genuine account therefore cannot match, not as a matter of care but because the domain
//      cannot exist. This is a stronger property than any naming convention: there is no "someone
//      happened to name their account that" failure mode.
//
//   2. EXPLICIT REAL-ACCOUNT ASSERTION. Before deleting anything the script re-reads every account
//      that does NOT match, and refuses outright if that set is empty -- a database where nothing
//      is being kept means the predicate has gone wrong, and it stops rather than proceeding.
//
//   3. DRY RUN BY DEFAULT. Nothing is deleted without --confirm.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db cleanup-test-users            # dry run, prints a preview
//   pnpm --filter @seatwise/db cleanup-test-users --confirm  # actually deletes

import "./load-env";
import { pool } from "../src/index";

/** Mirrors TEST_ACCOUNT_EMAIL_DOMAIN in e2e/support/auth.ts. Kept as a literal because packages/
 * deliberately does not import from e2e/ (the framework stays self-contained). */
const TEST_ACCOUNT_EMAIL_DOMAIN = "@example.invalid";

interface UserRow {
  id: string;
  email: string;
  name: string;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");

  const { rows: doomed } = await pool.query<UserRow>(
    `SELECT id, email, name FROM "users" WHERE email LIKE '%' || $1 ORDER BY "createdAt"`,
    [TEST_ACCOUNT_EMAIL_DOMAIN],
  );
  const { rows: kept } = await pool.query<UserRow>(
    `SELECT id, email, name FROM "users" WHERE email NOT LIKE '%' || $1 ORDER BY "createdAt"`,
    [TEST_ACCOUNT_EMAIL_DOMAIN],
  );

  console.log(`Users in DB: ${doomed.length + kept.length} total.\n`);

  // Guard 2: a run that keeps nothing means the predicate is wrong. Refuse rather than proceed.
  if (kept.length === 0) {
    console.error(
      "ABORT: this would delete every account in the database, keeping none.\n" +
        "That means the test-account predicate is not matching what it should. Nothing was deleted.",
    );
    process.exitCode = 1;
    await pool.end();
    return;
  }

  console.log(`Keeping ${kept.length} real account(s):`);
  for (const u of kept) console.log(`  KEEP ${u.email} (${u.name})`);

  // What the cascade will take with them, so the blast radius is visible before it happens.
  const { rows: fallout } = await pool.query<{ weddings: number; templates: number }>(
    `SELECT
       (SELECT count(*)::int FROM "weddings" w JOIN "users" u ON u.id = w."ownerId"
         WHERE u.email LIKE '%' || $1) AS weddings,
       (SELECT count(*)::int FROM "seating_templates" t JOIN "users" u ON u.id = t."ownerId"
         WHERE u.email LIKE '%' || $1) AS templates`,
    [TEST_ACCOUNT_EMAIL_DOMAIN],
  );

  console.log(`\n${confirmed ? "Deleting" : "Would delete"} ${doomed.length} test account(s).`);
  console.log(
    `Cascade will also remove ${fallout[0].weddings} wedding(s) and ${fallout[0].templates} template(s) owned by them.`,
  );
  for (const u of doomed.slice(0, 10)) console.log(`  ${confirmed ? "DELETE" : "would delete"} ${u.email}`);
  if (doomed.length > 10) console.log(`  ...and ${doomed.length - 10} more.`);

  if (!confirmed) {
    console.log("\nDry run only -- nothing was deleted. Re-run with --confirm to actually delete these.");
    await pool.end();
    return;
  }

  const { rowCount } = await pool.query(`DELETE FROM "users" WHERE email LIKE '%' || $1`, [
    TEST_ACCOUNT_EMAIL_DOMAIN,
  ]);
  console.log(`\nDeleted ${rowCount ?? 0} test account(s) (weddings and templates cascade-deleted with them).`);

  const { rows: after } = await pool.query<{ users: number; weddings: number; templates: number }>(
    `SELECT (SELECT count(*)::int FROM "users") AS users,
            (SELECT count(*)::int FROM "weddings") AS weddings,
            (SELECT count(*)::int FROM "seating_templates") AS templates`,
  );
  console.log(
    `Remaining: ${after[0].users} user(s), ${after[0].weddings} wedding(s), ${after[0].templates} template(s).`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  void pool.end();
});
