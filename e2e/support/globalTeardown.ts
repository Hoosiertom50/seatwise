// TS-102: run-level backstop that removes weddings left behind by tests that created them and
// didn't (or couldn't) clean up after themselves.
//
// Playwright runs this once, after every project and worker has finished -- see
// playwright.config.ts's `globalTeardown`. It is a safety net, not the primary mechanism: the
// `managedWedding` fixture and per-test cleanup remain the first line, and this catches the
// residue they structurally can't -- a test that crashed before its own teardown ran, or a future
// test written without cleanup in mind.
//
// ---------------------------------------------------------------------------
// SAFETY -- this is a bulk delete. Read before changing anything here.
// ---------------------------------------------------------------------------
//
// This sweep runs against the same local database that holds real weddings. The precedent for
// getting that wrong is `packages/db/prisma/fill-existing-weddings.ts`, which assumed the dev DB
// held only real data, ran against 559 rows, and mutated ~130 of them. Four guards, in order:
//
//   1. MARKER MATCH ONLY. A row is eligible only if its name contains TEST_DATA_MARKER, which
//      only e2e/data/ids.ts can produce (`uniqueTitle` / `tagTestName`). Never a pattern list,
//      never a heuristic, never "everything except the real ones" -- an allowlist of things to
//      delete, not a denylist of things to keep. A real wedding cannot be matched by accident;
//      it would have to be literally named with the marker.
//
//   2. OPT-OUT DRY RUN. The sweep deletes by default, because TS-102's acceptance criterion is
//      that a run -- including one with a deliberately-forced mid-run failure -- leaves the
//      wedding count unchanged, and an opt-in sweep cannot deliver that unless every caller
//      remembers to opt in. Set PW_TEARDOWN_SWEEP=dry-run to inspect what it would delete without
//      deleting. This was opt-in while the sweep was unverified; it was flipped only after the
//      full four-browser suite (496 tests) and the forced-crash case were both confirmed to
//      return the database to its exact pre-run count.
//
//   3. PRODUCTION REFUSAL. Reuses the same resolveIsProduction check the mutation guard uses. If
//      APP_URL resolves to a production hostname, this refuses outright regardless of arming.
//
//   4. NEVER FAILS THE RUN. A teardown throw would replace the suite's own result with a cleanup
//      error, hiding whatever the tests actually reported -- the same reasoning as the
//      `managedWedding` fixture's cleanup-warning attachment. Every failure here is logged and
//      swallowed.
//
// TS-104: seating templates are swept too, but as their own statement rather than via the wedding
// cascade -- they survive wedding deletion by design (`sourceWeddingId` goes null), so deleting a
// wedding never reaches them. Critically, they are matched on the marker ONLY, never on
// `sourceWeddingId IS NULL`: a template legitimately orphaned by a real planner deleting its source
// wedding is a supported product state, not test residue, and must never be swept.
//
// TS-215: so are the notification-breaking triggers and functions a killed run can leave behind
// (named pw_fail_notify_<test account id>, matched on that exact shape -- see sweepNotificationTriggers).
//
// TS-192: rate-limit counters the run left behind are cleared too -- only rows whose key holds a
// made-up test network address (198.18.x.x / 198.19.x.x, from uniqueTestAddress), a test account's
// email (@example.invalid) or a test account's id. Those can only have come from this suite, and
// leaving them for a day meant a later run that happened to reuse an address started out limited.
// Same guards as everything else here: never production, only a local database, dry run honoured.

import { Pool } from "pg";
import { getEnv } from "./env";
import { isLocalDatabaseUrl, resolveIsProduction } from "./productionGuard";
import { TEST_ADDRESS_PREFIXES, TEST_DATA_MARKER } from "../data/ids";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "./auth";
import { resolveDatabaseUrl } from "./testDatabase";

/** Set PW_TEARDOWN_SWEEP to exactly this to inspect without deleting. Any other value (including
 * unset) sweeps for real -- see guard 2 above for why this is opt-out rather than opt-in. */
const DRY_RUN_VALUE = "dry-run";

interface SweepRow {
  id: string;
  name: string;
}

/** TS-215: exactly the names breakNotificationsFor (testDatabase.ts) gives its trigger and function. */
export const TEST_TRIGGER_NAME = /^pw_fail_notify_[0-9a-f]{32}$/;

/**
 * TS-215: drops the triggers and functions testDatabase.ts's breakNotificationsFor makes. The test
 * removes them in its own `finally`, but a run killed part-way never gets there, and every later
 * notification for that account then failed in the local database. Only names matching
 * TEST_TRIGGER_NAME exactly (a test account's id), so nothing else can be touched. Logged, never
 * fails the run.
 */
async function sweepNotificationTriggers(pool: Pool, dryRun: boolean): Promise<void> {
  try {
    const { rows: triggers } = await pool.query<{ name: string }>(
      `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'notifications' AND NOT t.tgisinternal AND t.tgname LIKE 'pw\\_fail\\_notify\\_%'`,
    );
    const { rows: functions } = await pool.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = current_schema() AND p.proname LIKE 'pw\\_fail\\_notify\\_%'`,
    );
    const triggerNames = triggers.map((t) => t.name).filter((n) => TEST_TRIGGER_NAME.test(n));
    const functionNames = functions.map((f) => f.name).filter((n) => TEST_TRIGGER_NAME.test(n));
    if (triggerNames.length === 0 && functionNames.length === 0) return;
    if (dryRun) {
      console.log(`[teardown-sweep] DRY RUN -- ${triggerNames.length} test trigger(s) and ${functionNames.length} test function(s) would be dropped.`);
      return;
    }
    for (const name of triggerNames) await pool.query(`DROP TRIGGER IF EXISTS ${name} ON "notifications"`);
    for (const name of functionNames) await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    console.log(`[teardown-sweep] Dropped ${triggerNames.length} test trigger(s) and ${functionNames.length} test function(s).`);
  } catch (err) {
    console.warn(`[teardown-sweep] Test trigger sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** TS-215: projects that never touch the database (no app, no browser). */
const DATABASE_FREE_PROJECTS = new Set(["framework-unit", "unit"]);

/**
 * TS-215: the projects named on the command line (`--project=x` or `--project x`), or null when
 * none were (every project runs). Playwright runs this teardown for any run, whatever projects it
 * selects -- so a quick unit-test run used to sweep away every test account while a browser run in
 * another terminal was still using them.
 */
export function selectedProjects(argv: readonly string[]): string[] | null {
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--project=")) names.push(arg.slice("--project=".length));
    else if (arg === "--project" && i + 1 < argv.length) names.push(argv[++i]);
  }
  return names.length > 0 ? names : null;
}

/** TS-215: true when only database-free projects were selected -- then there's nothing to sweep. */
export function onlyDatabaseFreeProjects(argv: readonly string[]): boolean {
  const names = selectedProjects(argv);
  return names !== null && names.every((n) => DATABASE_FREE_PROJECTS.has(n));
}

export default async function globalTeardown(): Promise<void> {
  const dryRun = process.env.PW_TEARDOWN_SWEEP === DRY_RUN_VALUE;
  if (onlyDatabaseFreeProjects(process.argv)) return;

  let pool: Pool | undefined;
  try {
    const env = getEnv();

    // Guard 3: never sweep anything that resolves to production, armed or not.
    // TS-74: the same parsed list as the guard -- including KNOWN_PRODUCTION_HOSTNAMES.
    if (resolveIsProduction(env.APP_URL, env.PRODUCTION_HOSTNAMES)) {
      console.warn(`[teardown-sweep] REFUSED: ${env.APP_URL} resolves to a production hostname.`);
      return;
    }

    const connectionString = resolveDatabaseUrl();
    if (!connectionString) {
      console.warn("[teardown-sweep] SKIPPED: no DATABASE_URL in the environment or the root .env.");
      return;
    }
    // TS-172: only ever a local (or CI) database.
    if (!isLocalDatabaseUrl(connectionString)) {
      console.warn("[teardown-sweep] REFUSED: DATABASE_URL isn't a local database.");
      return;
    }

    pool = new Pool({ connectionString });

    // TS-215: notification-breaking triggers (testDatabase.ts's breakNotificationsFor) left by a run
    // killed before the test's own `finally` put things back.
    await sweepNotificationTriggers(pool, dryRun);

    // Guard 1: marker match only. This predicate is the whole safety model -- it is the single
    // place that decides a row may be deleted, and it can only ever match names ids.ts produced.
    // Note what is deliberately absent from the template query: any condition on
    // `sourceWeddingId IS NULL`. An orphaned template is a supported product state (a planner
    // deleted the wedding it was saved from), so orphanhood must never imply deletability.
    const { rows: weddings } = await pool.query<SweepRow>(
      `SELECT id, name FROM "weddings" WHERE name LIKE '%' || $1 || '%' ORDER BY "createdAt"`,
      [TEST_DATA_MARKER],
    );
    const { rows: templates } = await pool.query<SweepRow>(
      `SELECT id, name FROM "seating_templates" WHERE name LIKE '%' || $1 || '%' ORDER BY "createdAt"`,
      [TEST_DATA_MARKER],
    );

    // TS-103: accounts this framework signed up. Matched on the reserved .invalid domain (see
    // TEST_ACCOUNT_EMAIL_DOMAIN in auth.ts), which a real account cannot hold because the domain
    // cannot exist. This is the root of the cascade -- User -> Wedding -> everything, and User ->
    // SeatingTemplate -- so it also removes any wedding or template the two sweeps above missed.
    const { rows: users } = await pool.query<{ id: string; email: string }>(
      `SELECT id, email FROM "users" WHERE email LIKE '%' || $1 ORDER BY "createdAt"`,
      [TEST_ACCOUNT_EMAIL_DOMAIN],
    );

    // TS-192: counters keyed on a test address, a test email or a test account's id. Keys end in
    // ":<address>", ":<email>" or ":<user id>" (apps/web/src/lib/rate-limit.ts); ids are generated
    // by the database and hold no LIKE wildcards.
    const counterPatterns = [
      ...TEST_ADDRESS_PREFIXES.map((prefix) => `%:${prefix}%`),
      `%${TEST_ACCOUNT_EMAIL_DOMAIN}%`,
      ...users.map((u) => `%:${u.id}`),
    ];
    const { rows: counterRows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "rate_limit_counters" WHERE key LIKE ANY($1::text[])`,
      [counterPatterns],
    );
    const counters = counterRows[0]?.n ?? 0;

    if (weddings.length === 0 && templates.length === 0 && users.length === 0 && counters === 0) {
      console.log("[teardown-sweep] Nothing to sweep -- no test-created rows remain.");
      return;
    }

    // Guard 2: delete unless explicitly asked not to.
    if (dryRun) {
      console.log(
        `[teardown-sweep] DRY RUN -- ${weddings.length} wedding(s), ${templates.length} template(s) and ` +
          `${users.length} test account(s) and ${counters} test rate-limit counter(s) would be deleted. ` +
          `Unset PW_TEARDOWN_SWEEP to actually delete them.`,
      );
      for (const row of weddings.slice(0, 5)) console.log(`  wedding:  "${row.name}" (${row.id})`);
      if (weddings.length > 5) console.log(`  ... and ${weddings.length - 5} more weddings`);
      for (const row of templates.slice(0, 5)) console.log(`  template: "${row.name}" (${row.id})`);
      if (templates.length > 5) console.log(`  ... and ${templates.length - 5} more templates`);
      for (const row of users.slice(0, 5)) console.log(`  account:  ${row.email} (${row.id})`);
      if (users.length > 5) console.log(`  ... and ${users.length - 5} more accounts`);
      return;
    }

    // Templates first: they are exempt from the wedding cascade, so deleting weddings first would
    // simply null out their sourceWeddingId and leave them behind.
    const { rowCount: templatesDeleted } = await pool.query(
      `DELETE FROM "seating_templates" WHERE name LIKE '%' || $1 || '%'`,
      [TEST_DATA_MARKER],
    );

    // Everything under a wedding cascades (guests, tables, plan versions, seat assignments,
    // comments, timeline entries, vendors, collaborators, invites) -- see schema.prisma. Deleting
    // the wedding row is enough. The marker predicate is repeated here rather than deleting by
    // the ids collected above, so the delete itself is still marker-scoped even if this query is
    // ever refactored apart from the select.
    const { rowCount: weddingsDeleted } = await pool.query(
      `DELETE FROM "weddings" WHERE name LIKE '%' || $1 || '%'`,
      [TEST_DATA_MARKER],
    );
    // TS-103: accounts last. User is the root of the cascade, so this also catches any wedding or
    // template belonging to a test account that the marker-scoped statements above did not match
    // (e.g. a row created before the marker existed, or one named outside ids.ts entirely).
    // TS-187: the database no longer deletes a wedding along with its owner's account (ON DELETE
    // RESTRICT), so any wedding a test account still owns goes first.
    await pool.query(
      `DELETE FROM "weddings" WHERE "ownerId" IN (SELECT id FROM "users" WHERE email LIKE '%' || $1)`,
      [TEST_ACCOUNT_EMAIL_DOMAIN],
    );
    const { rowCount: usersDeleted } = await pool.query(
      `DELETE FROM "users" WHERE email LIKE '%' || $1`,
      [TEST_ACCOUNT_EMAIL_DOMAIN],
    );
    // TS-192: the run's rate-limit counters (see the note at the top).
    const { rowCount: countersDeleted } = await pool.query(
      `DELETE FROM "rate_limit_counters" WHERE key LIKE ANY($1::text[])`,
      [counterPatterns],
    );

    console.log(
      `[teardown-sweep] Deleted ${weddingsDeleted ?? 0} marker-tagged wedding(s), ` +
        `${templatesDeleted ?? 0} template(s), ${usersDeleted ?? 0} test account(s) and ` +
        `${countersDeleted ?? 0} test rate-limit counter(s).`,
    );
  } catch (err) {
    // Guard 4: never fail the run over cleanup.
    console.warn(
      `[teardown-sweep] Sweep failed (the test run's own result is unaffected): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await pool?.end().catch(() => undefined);
  }
}
