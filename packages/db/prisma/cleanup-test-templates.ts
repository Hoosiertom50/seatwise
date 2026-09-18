// TS-104: one-time (and safely repeatable) cleanup of seating templates left behind by E2E runs.
//
// Why templates need their own script at all: `cleanup-test-weddings.ts` works by deleting wedding
// rows and letting `onDelete: Cascade` remove everything beneath them. Templates are deliberately
// exempt from that cascade -- per the `SeatingTemplate` comment in schema.prisma, a template is a
// standalone reusable asset, so deleting its source wedding sets `sourceWeddingId` to null and the
// template survives. That is correct product behaviour, and it is also why 176 test templates were
// still sitting in the dev database after the wedding count was already back to its baseline.
//
// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------
//
//   1. NEVER MATCHES ON ORPHANHOOD. A template with a null `sourceWeddingId` is a supported
//      product state -- a planner deleted the wedding they saved it from and kept the layout. This
//      script does not look at `sourceWeddingId` at all. Orphaned is not the same as disposable.
//
//   2. TWO NAME PREDICATES, BOTH GENERATED-ONLY:
//        a. the TS-102 marker, carried by everything e2e/data/ids.ts produces today; and
//        b. the `uniqueTitle` shape -- "<label> <workerIndex>-<epochMillis>-<counter>" -- which
//           covers templates created before the marker existed. A planner naming a template by
//           hand does not produce a 13-digit epoch and a counter.
//      Anything matching neither is left alone.
//
//   3. DRY RUN BY DEFAULT. Nothing is deleted without --confirm.
//
// Usage (from the repo root):
//   pnpm --filter @seatwise/db cleanup-test-templates            # dry run, prints a preview
//   pnpm --filter @seatwise/db cleanup-test-templates --confirm  # actually deletes

import "./load-env";
import { pool } from "../src/index";

/** Mirrors TEST_DATA_MARKER in e2e/data/ids.ts. Kept as a literal because packages/ deliberately
 * does not import from e2e/ (the framework stays self-contained; see e2e/tests/unit/ids.spec.ts). */
const TEST_DATA_MARKER = "pwqa-fixture";

/** Mirrors uniqueTitle's output shape: "<label> <workerIndex>-<epochMillis>-<counter>". */
const GENERATED_NAME_SHAPE = String.raw`[0-9]+-1[0-9]{12}-[0-9]+$`;

interface TemplateRow {
  id: string;
  name: string;
  sourceWeddingId: string | null;
  createdAt: Date;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");

  const { rows: doomed } = await pool.query<TemplateRow>(
    `SELECT id, name, "sourceWeddingId", "createdAt"
       FROM "seating_templates"
      WHERE name LIKE '%' || $1 || '%' OR name ~ $2
      ORDER BY "createdAt"`,
    [TEST_DATA_MARKER, GENERATED_NAME_SHAPE],
  );

  const { rows: kept } = await pool.query<TemplateRow>(
    `SELECT id, name, "sourceWeddingId", "createdAt"
       FROM "seating_templates"
      WHERE NOT (name LIKE '%' || $1 || '%' OR name ~ $2)
      ORDER BY "createdAt"`,
    [TEST_DATA_MARKER, GENERATED_NAME_SHAPE],
  );

  console.log(`Templates in DB: ${doomed.length + kept.length} total.\n`);

  console.log(`Keeping ${kept.length} template(s) (no generated-name signature):`);
  if (kept.length === 0) {
    console.log("  (none)");
  } else {
    for (const t of kept.slice(0, 20)) {
      console.log(`  KEEP "${t.name}"${t.sourceWeddingId === null ? " [orphaned — kept anyway]" : ""}`);
    }
    if (kept.length > 20) console.log(`  ...and ${kept.length - 20} more.`);
  }

  console.log(`\n${confirmed ? "Deleting" : "Would delete"} ${doomed.length} template(s):`);
  for (const t of doomed.slice(0, 15)) {
    console.log(`  ${confirmed ? "DELETE" : "would delete"} "${t.name}" (${t.id})`);
  }
  if (doomed.length > 15) console.log(`  ...and ${doomed.length - 15} more.`);

  if (!confirmed) {
    console.log("\nDry run only -- nothing was deleted. Re-run with --confirm to actually delete these.");
    await pool.end();
    return;
  }

  if (doomed.length > 0) {
    const { rowCount } = await pool.query(
      `DELETE FROM "seating_templates" WHERE name LIKE '%' || $1 || '%' OR name ~ $2`,
      [TEST_DATA_MARKER, GENERATED_NAME_SHAPE],
    );
    console.log(`\nDeleted ${rowCount ?? 0} template(s).`);
  }

  const { rows: remaining } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "seating_templates"`,
  );
  console.log(`${remaining[0].n} template(s) remain in the database.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  void pool.end();
});
