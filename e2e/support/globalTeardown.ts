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
// Templates are deliberately NOT swept here yet -- they survive wedding deletion by design
// (`sourceWeddingId` goes null) so the cascade never reaches them, and a legitimately orphaned
// template is a supported product state. That needs its own marker-scoped handling: see TS-104.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { getEnv } from "./env";
import { resolveIsProduction } from "./productionGuard";
import { TEST_DATA_MARKER } from "../data/ids";

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
    const { rows } = await pool.query<SweepRow>(
      `SELECT id, name FROM "weddings" WHERE name LIKE '%' || $1 || '%' ORDER BY "createdAt"`,
      [TEST_DATA_MARKER],
    );

    if (rows.length === 0) {
      console.log("[teardown-sweep] Nothing to sweep -- no marker-tagged weddings remain.");
      return;
    }

    // Guard 2: delete unless explicitly asked not to.
    if (dryRun) {
      console.log(
        `[teardown-sweep] DRY RUN -- ${rows.length} marker-tagged wedding(s) would be deleted. ` +
          `Unset PW_TEARDOWN_SWEEP to actually delete them.`,
      );
      for (const row of rows.slice(0, 10)) console.log(`  would delete: "${row.name}" (${row.id})`);
      if (rows.length > 10) console.log(`  ... and ${rows.length - 10} more`);
      return;
    }

    // Everything under a wedding cascades (guests, tables, plan versions, seat assignments,
    // comments, timeline entries, vendors, collaborators, invites) -- see schema.prisma. Deleting
    // the wedding row is enough. The marker predicate is repeated here rather than deleting by
    // the ids collected above, so the delete itself is still marker-scoped even if this query is
    // ever refactored apart from the select.
    const { rowCount } = await pool.query(
      `DELETE FROM "weddings" WHERE name LIKE '%' || $1 || '%'`,
      [TEST_DATA_MARKER],
    );
    console.log(`[teardown-sweep] Deleted ${rowCount ?? 0} marker-tagged wedding(s).`);
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
