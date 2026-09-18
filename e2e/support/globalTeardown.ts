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

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { getEnv } from "./env";
import { resolveIsProduction } from "./productionGuard";
import { TEST_DATA_MARKER } from "../data/ids";
import { TEST_ACCOUNT_EMAIL_DOMAIN } from "./auth";

/** Set PW_TEARDOWN_SWEEP to exactly this to inspect without deleting. Any other value (including
 * unset) sweeps for real -- see guard 2 above for why this is opt-out rather than opt-in. */
const DRY_RUN_VALUE = "dry-run";

interface SweepRow {
  id: string;
  name: string;
}

/**
 * DATABASE_URL lives in the repo-root .env, which nothing in the Playwright process loads (the
 * app and Prisma CLI each load their own). Read it directly rather than adding a dotenv dependency
 * for one value. Returns undefined -- and the sweep then skips -- if it isn't found either way.
 */
function resolveDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No root .env, or unreadable -- fall through to undefined and skip.
  }
  return undefined;
}

export default async function globalTeardown(): Promise<void> {
  const dryRun = process.env.PW_TEARDOWN_SWEEP === DRY_RUN_VALUE;

  let pool: Pool | undefined;
  try {
    const env = getEnv();

    // Guard 3: never sweep anything that resolves to production, armed or not.
    const productionHostnames = (process.env.PRODUCTION_HOSTNAMES ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (resolveIsProduction(env.APP_URL, productionHostnames)) {
      console.warn(`[teardown-sweep] REFUSED: ${env.APP_URL} resolves to a production hostname.`);
      return;
    }

    const connectionString = resolveDatabaseUrl();
    if (!connectionString) {
      console.warn("[teardown-sweep] SKIPPED: no DATABASE_URL in the environment or the root .env.");
      return;
    }

    pool = new Pool({ connectionString });

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

    if (weddings.length === 0 && templates.length === 0 && users.length === 0) {
      console.log("[teardown-sweep] Nothing to sweep -- no test-created rows remain.");
      return;
    }

    // Guard 2: delete unless explicitly asked not to.
    if (dryRun) {
      console.log(
        `[teardown-sweep] DRY RUN -- ${weddings.length} wedding(s), ${templates.length} template(s) and ` +
          `${users.length} test account(s) would be deleted. Unset PW_TEARDOWN_SWEEP to actually delete them.`,
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
    const { rowCount: usersDeleted } = await pool.query(
      `DELETE FROM "users" WHERE email LIKE '%' || $1`,
      [TEST_ACCOUNT_EMAIL_DOMAIN],
    );

    console.log(
      `[teardown-sweep] Deleted ${weddingsDeleted ?? 0} marker-tagged wedding(s), ` +
        `${templatesDeleted ?? 0} template(s) and ${usersDeleted ?? 0} test account(s).`,
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
