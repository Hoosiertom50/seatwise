// TS-183: re-checks every wedding's current seating plan with the app's own checks, and recounts
// whether it's complete. Safe to run more than once.
//
// WHY: the declined-guests migration (20261005170000_declined_guests_not_attending) frees the seats
// of guests who had declined, and recounts completeness in plain SQL -- but it can't run the app's
// per-table re-check (capacity, accessible tables, restricted lists, must / must-not sit together).
// A freed seat can make room for someone flagged at that table, so after the migration some Needs
// Reassignment flags may be out of date until something else re-checks that table. This does it
// for every table, the same way the app does after any change: resyncTables over every table of
// the wedding in its current plan, then refreshPlanCompleteness, and -- where flags changed on an
// approved plan -- recordRecheckIfApproved (so it shows "Modified since approval").
//
// The migration itself is deliberately left unchanged (it isn't applied on the live site yet, and
// editing an applied migration changes its checksum).
//
// SAFETY:
//   * DRY RUN BY DEFAULT: each wedding is re-checked inside a transaction that is rolled back, so
//     it reports exactly what would change and writes nothing. --confirm commits instead.
//   * One transaction per wedding, taking the same locks in the same order as the app (the wedding,
//     then its current plan, then tables and seats), so it can run while the site is in use.
//   * Nobody is ever unseated -- the re-check only sets or clears Needs Reassignment flags.
//   * LOCAL ONLY unless run with --target-production (same opt-in as encrypt-old-link-tokens; see
//     production-target.ts): it then asks for the live DATABASE_URL (or reads
//     PRODUCTION_DATABASE_URL) without echoing it, and never prints it.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db recheck-current-plans                       # local, dry run
//   pnpm --filter @seatwise/db recheck-current-plans -- --confirm          # local, writes
// On the live site, right after publishing (see the README's publish steps):
//   read -rs PRODUCTION_DATABASE_URL && export PRODUCTION_DATABASE_URL
//   pnpm --filter @seatwise/db recheck-current-plans -- --target-production            # dry run
//   pnpm --filter @seatwise/db recheck-current-plans -- --target-production --confirm  # writes

// TS-172: local databases only (see local-only.ts) -- TS-183: unless --target-production.
import "./local-only";
import { targetsProduction, useProductionDatabase } from "./production-target";

interface WeddingResult {
  name: string;
  changed: boolean;
  newlyFlagged: number;
  wasComplete: boolean;
  isComplete: boolean;
  approved: boolean;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");
  if (targetsProduction()) await useProductionDatabase();
  // Imported only now, so the shared pool connects to the database chosen above.
  const db = await import("../src/index");
  const { pool } = db;

  try {
    const { rows: weddings } = await pool.query<{ id: string; name: string }>(
      `SELECT w.id, w.name FROM "weddings" w
        WHERE EXISTS (SELECT 1 FROM "plan_versions" pv WHERE pv."weddingId" = w.id AND pv."isCurrent")
        ORDER BY w."createdAt", w.id`
    );
    console.log(`${weddings.length} wedding(s) with a current plan.${confirmed ? "" : " Dry run -- nothing will be saved."}`);

    const results: WeddingResult[] = [];
    for (const w of weddings) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT id FROM "weddings" WHERE id = $1 FOR UPDATE`, [w.id]);
        const planVersionId = await db.lockCurrentPlan(client, w.id);
        if (!planVersionId) {
          await client.query("ROLLBACK");
          continue;
        }
        const { rows: before } = await client.query(`SELECT status, "isComplete" FROM "plan_versions" WHERE id = $1`, [
          planVersionId,
        ]);
        const { rows: tables } = await client.query(`SELECT id FROM "seating_tables" WHERE "weddingId" = $1`, [w.id]);
        const { newlyFlagged, changed } = await db.resyncTables(
          client,
          w.id,
          planVersionId,
          tables.map((t) => t.id as string)
        );
        await db.refreshPlanCompleteness(client, w.id, planVersionId, { bumpRevision: changed });
        if (changed) {
          await db.recordRecheckIfApproved(
            client,
            planVersionId,
            "Seating re-checked after an update — some guests' Needs Reassignment flags changed",
            null
          );
        }
        const { rows: after } = await client.query(`SELECT "isComplete" FROM "plan_versions" WHERE id = $1`, [planVersionId]);
        await client.query(confirmed ? "COMMIT" : "ROLLBACK");
        results.push({
          name: w.name,
          changed,
          newlyFlagged: newlyFlagged.length,
          wasComplete: before[0].isComplete as boolean,
          isComplete: after[0].isComplete as boolean,
          approved: before[0].status === "APPROVED",
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    const touched = results.filter((r) => r.changed || r.wasComplete !== r.isComplete);
    for (const r of touched) {
      console.log(
        `  ${r.name}: ${r.changed ? `flags changed (${r.newlyFlagged} newly flagged)` : "flags unchanged"}, ` +
          `${r.wasComplete ? "complete" : "incomplete"} -> ${r.isComplete ? "complete" : "incomplete"}` +
          (r.approved && r.changed ? " (approved -- recorded as modified since approval)" : "")
      );
    }
    console.log(
      `\n${touched.length} of ${results.length} current plan(s) ${confirmed ? "were updated" : "would change"}; the rest were already up to date.`
    );
    if (!confirmed) console.log("Dry run only -- nothing was written. Re-run with --confirm to save.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // Only the message -- an error object can carry connection details.
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
