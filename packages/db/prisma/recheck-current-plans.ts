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
// TS-187: it also catches declines the migration couldn't. Between running the migration and the
// new code going live, the old code was still answering RSVPs -- and a guest who declined in that
// gap was saved as Declined but stayed Attending (and kept their seat). Every guest who has
// declined but is still Attending is marked Not Attending here, with the app's own attendance
// change (applyAttendanceChange): their seat in the current plan is freed, the tables it touches
// are re-checked, and it's recorded in the plan's history. A dry run lists them.
//
// The migration itself is deliberately left unchanged (it isn't applied on the live site yet, and
// editing an applied migration changes its checksum).
//
// SAFETY:
//   * DRY RUN BY DEFAULT: each wedding is re-checked inside a transaction that is rolled back, so
//     it reports exactly what would change and writes nothing. --confirm commits instead.
//   * One transaction per wedding, taking the same locks in the same order as the app (the wedding,
//     then its current plan, then guests, tables and seats), so it can run while the site is in use.
//     TS-187: a wedding whose locks can't be had within 10 seconds (someone is mid-change), or whose
//     transaction the database breaks to resolve a deadlock, is tried again, up to 3 times; if it
//     still can't be done it's skipped and listed at the end -- the rest of the run carries on.
//     Running the script again later picks it up.
//   * Nobody is ever unseated except guests who have declined (above) -- otherwise the re-check
//     only sets or clears Needs Reassignment flags.
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
  hasPlan: boolean;
  changed: boolean;
  newlyFlagged: number;
  wasComplete: boolean;
  isComplete: boolean;
  approved: boolean;
  /** TS-187: guests who had declined but were still Attending, now Not Attending. */
  declined: { name: string; seatFreed: boolean }[];
}

// TS-187: the errors that mean "someone else was changing this wedding at the same moment" -- a
// deadlock the database broke (40P01), a lock not had within lock_timeout (55P03), or the current
// plan replaced again and again while waiting for it (40001, see lockCurrentPlan).
const RETRYABLE = new Set(["40P01", "55P03", "40001"]);
const ATTEMPTS = 3;

async function main() {
  const confirmed = process.argv.includes("--confirm");
  if (targetsProduction()) await useProductionDatabase();
  // Imported only now, so the shared pool connects to the database chosen above.
  const db = await import("../src/index");
  const { pool } = db;

  // One wedding's whole re-check, in one transaction (committed with --confirm, else rolled back).
  async function recheckWedding(w: { id: string; name: string }): Promise<WeddingResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // TS-187: don't wait on someone's change for long -- give up (55P03) and try again instead.
      await client.query(`SET LOCAL lock_timeout = '10s'`);
      // TS-187: NO KEY UPDATE, like the app's own wedding lock (TS-185).
      await client.query(`SELECT id FROM "weddings" WHERE id = $1 FOR NO KEY UPDATE`, [w.id]);
      const planVersionId = await db.lockCurrentPlan(client, w.id);
      const { rows: before } = planVersionId
        ? await client.query(`SELECT status, "isComplete" FROM "plan_versions" WHERE id = $1`, [planVersionId])
        : { rows: [] as { status: string; isComplete: boolean }[] };

      // TS-187: guests who declined but are still Attending (see WHY) -- the app's own change.
      const { rows: declinedGuests } = await client.query<{ id: string; name: string }>(
        `SELECT id, ("firstName" || ' ' || "lastName") AS name FROM "guests"
         WHERE "weddingId" = $1 AND "rsvpStatus" = 'DECLINED' AND "dayOfAttendance" = 'ATTENDING'
         ORDER BY id FOR NO KEY UPDATE`,
        [w.id]
      );
      const declined: WeddingResult["declined"] = [];
      for (const g of declinedGuests) {
        const { seatFreed } = await db.applyAttendanceChange(client, w.id, planVersionId, g, "NOT_ATTENDING", null);
        declined.push({ name: g.name, seatFreed });
      }

      let changed = false;
      let newlyFlagged = 0;
      if (planVersionId) {
        const { rows: tables } = await client.query(`SELECT id FROM "seating_tables" WHERE "weddingId" = $1`, [w.id]);
        const result = await db.resyncTables(
          client,
          w.id,
          planVersionId,
          tables.map((t) => t.id as string)
        );
        changed = result.changed;
        newlyFlagged = result.newlyFlagged.length;
        await db.refreshPlanCompleteness(client, w.id, planVersionId, { bumpRevision: changed });
        if (changed) {
          await db.recordRecheckIfApproved(
            client,
            planVersionId,
            "Seating re-checked after an update — some guests' Needs Reassignment flags changed",
            null
          );
        }
      }
      const { rows: after } = planVersionId
        ? await client.query(`SELECT "isComplete" FROM "plan_versions" WHERE id = $1`, [planVersionId])
        : { rows: [] as { isComplete: boolean }[] };
      await client.query(confirmed ? "COMMIT" : "ROLLBACK");
      return {
        name: w.name,
        hasPlan: !!planVersionId,
        changed,
        newlyFlagged,
        wasComplete: (before[0]?.isComplete as boolean | undefined) ?? false,
        isComplete: (after[0]?.isComplete as boolean | undefined) ?? false,
        approved: before[0]?.status === "APPROVED",
        declined,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  try {
    // Every wedding with a current plan, and (TS-187) every wedding with a guest who declined but is
    // still Attending, plan or not.
    const { rows: weddings } = await pool.query<{ id: string; name: string }>(
      `SELECT w.id, w.name FROM "weddings" w
        WHERE EXISTS (SELECT 1 FROM "plan_versions" pv WHERE pv."weddingId" = w.id AND pv."isCurrent")
           OR EXISTS (SELECT 1 FROM "guests" g WHERE g."weddingId" = w.id
                        AND g."rsvpStatus" = 'DECLINED' AND g."dayOfAttendance" = 'ATTENDING')
        ORDER BY w."createdAt", w.id`
    );
    console.log(`${weddings.length} wedding(s) to check.${confirmed ? "" : " Dry run -- nothing will be saved."}`);

    const results: WeddingResult[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const w of weddings) {
      for (let attempt = 1; ; attempt++) {
        try {
          results.push(await recheckWedding(w));
          break;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (!code || !RETRYABLE.has(code)) throw err;
          if (attempt >= ATTEMPTS) {
            skipped.push({
              name: w.name,
              reason: code === "40P01" ? "kept clashing with another change (deadlock)" : "kept waiting on another change",
            });
            break;
          }
          // Someone was mid-change; give them a moment, then try this wedding again.
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    const touched = results.filter((r) => r.changed || r.wasComplete !== r.isComplete || r.declined.length > 0);
    for (const r of touched) {
      const parts: string[] = [];
      if (r.declined.length > 0) {
        const freed = r.declined.filter((d) => d.seatFreed).length;
        parts.push(
          `${r.declined.length} declined guest(s) ${confirmed ? "marked" : "would be marked"} not attending ` +
            `(${r.declined.map((d) => d.name).join(", ")}; ${freed} seat(s) freed)`
        );
      }
      if (r.hasPlan) {
        parts.push(
          `${r.changed ? `flags changed (${r.newlyFlagged} newly flagged)` : "flags unchanged"}, ` +
            `${r.wasComplete ? "complete" : "incomplete"} -> ${r.isComplete ? "complete" : "incomplete"}` +
            (r.approved && (r.changed || r.declined.some((d) => d.seatFreed)) ? " (approved -- recorded as modified since approval)" : "")
        );
      }
      console.log(`  ${r.name}: ${parts.join("; ")}`);
    }
    console.log(
      `\n${touched.length} of ${results.length} wedding(s) ${confirmed ? "were updated" : "would change"}; the rest were already up to date.`
    );
    if (skipped.length > 0) {
      console.log(`\n${skipped.length} wedding(s) skipped -- someone was changing them; run this again to finish them:`);
      for (const s of skipped) console.log(`  ${s.name}: ${s.reason}`);
      process.exitCode = 1;
    }
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
