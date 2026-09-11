/**
 * Stage 10 — the pure logic behind `playwright-framework/cli/ci-summary.ts`, split out into its own
 * side-effect-free module for exactly the reason `parseRunArgs.ts` was split out of `run-tests.ts`
 * in Stage 05: so it can be unit-tested directly against synthetic `RunReport` fixtures, rather than
 * only indirectly through the CLI's own process exit code and stdout.
 *
 * See the CLI module's own doc comment for the full "why this has to exist" writeup (the real,
 * verified fact that `playwright test` exits 0 for both a zero-match `--grep` and an empty
 * `--shard`, and that Playwright still writes a normalized run report -- all-zero counts, `tests:
 * []` -- for that case, indistinguishable at a glance from a report worth calling a clean pass).
 */
import type { RunReport } from "../metadata/schemas.js";

export interface CiSummaryResult {
  total: number;
  cleanPass: number;
  flaky: number;
  failed: number;
  skipped: number;
  expectedFailure: number;
  quarantined: number;
  setupFailure: number;
  isZeroTestRun: boolean;
  markdownSummary: string;
  annotations: string[];
}

/** Pure function: no filesystem access, no `process.exit`, no environment reads. */
export function summarizeRunReport(report: RunReport): CiSummaryResult {
  const c = report.counts;
  const total = c.initialPass + c.retryPass + c.consistentFailure + c.timeout + c.skipped + c.expectedFailure + c.quarantined + c.setupFailure;
  const failed = c.consistentFailure + c.timeout + c.setupFailure;
  const isZeroTestRun = total === 0;

  const annotations: string[] = [];
  if (isZeroTestRun) {
    annotations.push(
      `::error::Run ${report.runId} matched and executed ZERO tests (selection: "${report.tagExpression || "(none)"}", matched=${report.selectionSummary.matchedCount}, excluded=${report.selectionSummary.excludedCount}). Playwright itself exits 0 for this case -- treating it as a hard CI failure rather than letting it read as an ordinary clean pass (Stage 10 acceptance criterion).`,
    );
  }
  if (c.retryPass > 0) {
    annotations.push(
      `::warning::${c.retryPass} test(s) only passed after a retry (flaky) in run ${report.runId}. Playwright's own exit code still treats this as a pass -- surfaced here so a flaky pass is never indistinguishable from a clean one. See the run report for which test(s).`,
    );
  }
  if (c.quarantined > 0) {
    annotations.push(
      `::warning::${c.quarantined} quarantined test(s) executed in run ${report.runId}. A quarantined test is normally excluded from the smoke/regression selections by tag conflict -- seeing one run at all is worth a human's attention.`,
    );
  }
  if (failed > 0) {
    annotations.push(`::error::${failed} test(s) failed (consistent failure, timeout, or setup failure) in run ${report.runId}.`);
  }

  const rows = [
    ["Total tests executed", String(total)],
    ["Clean pass (initial-pass)", String(c.initialPass)],
    ["Flaky (retry-pass)", String(c.retryPass)],
    ["Failed (consistent-failure + timeout + setup-failure)", String(failed)],
    ["Skipped", String(c.skipped)],
    ["Expected failure", String(c.expectedFailure)],
    ["Quarantined", String(c.quarantined)],
  ];
  const markdownSummary = [
    `## Playwright run summary (\`${report.runId}\`)`,
    "",
    isZeroTestRun
      ? "**⚠️ ZERO TESTS EXECUTED** -- this is treated as a hard failure, not a clean pass. See the error annotation above for the selection that produced this."
      : failed > 0
        ? `**${failed} test(s) failed.**`
        : c.retryPass > 0
          ? `**Passed, but ${c.retryPass} test(s) required a retry (flaky) -- not an ordinary clean pass.**`
          : "**Clean pass.**",
    "",
    "| Metric | Count |",
    "|---|---|",
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    "",
    `Selection: \`${report.tagExpression || "(none -- direct invocation)"}\` -- matched ${report.selectionSummary.matchedCount}, excluded ${report.selectionSummary.excludedCount}.`,
    "",
  ].join("\n");

  return {
    total,
    cleanPass: c.initialPass,
    flaky: c.retryPass,
    failed,
    skipped: c.skipped,
    expectedFailure: c.expectedFailure,
    quarantined: c.quarantined,
    setupFailure: c.setupFailure,
    isZeroTestRun,
    markdownSummary,
    annotations,
  };
}
