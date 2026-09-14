#!/usr/bin/env node
/**
 * Stage 10 — the CI status-gating CLI (spec Section 11's "branch/PR status behavior for failed,
 * flaky, quarantined, and zero-test runs" acceptance criterion). Run as a dedicated step immediately
 * after a real `playwright test` invocation, reading the Stage 06 normalized run report that
 * invocation just produced (never rerunning anything) and:
 *
 *   1. Writing a human-readable pass/fail/flaky/quarantined breakdown to `$GITHUB_STEP_SUMMARY`
 *      (when set -- a no-op outside GitHub Actions, e.g. a local `pnpm exec tsx` invocation).
 *   2. Emitting `::warning::`/`::error::` workflow-command annotations for anything that should be
 *      visible on the PR/commit checks list, not just buried in the CI report artifacts.
 *   3. Exiting non-zero on a genuine zero-test run.
 *
 * The actual classification/formatting logic lives in `playwright-framework/reporting/
 * ciSummary.ts`'s `summarizeRunReport` (a pure function, unit-tested directly) -- this file is only
 * the thin CLI shell around it (finding the target run report, printing, exiting), the same split
 * Stage 05's `run-tests.ts`/`parseRunArgs.ts` established.
 *
 * WHY THIS SCRIPT HAS TO EXIST, verified live rather than assumed (see PLAYWRIGHT_TESTING.md's "CI
 * status behavior" section for the full writeup): `pnpm exec playwright test -g "<a pattern that
 * matches nothing>"` prints "Error: No tests found" to stderr but exits **0**. So does
 * `--shard=N/M` when a shard's slice of the suite happens to be empty. Playwright's own reporters
 * (list/html) print nothing alarming for either case, and the normalized Stage 06 run report is
 * still written -- with `tests: []` and every count at 0 -- exactly like a report from a suite that
 * genuinely has nothing to test would look. Left unchecked, a CI misconfiguration (a typo'd tag
 * expression, a shard count that outgrew the suite) would show up on GitHub as an ordinary green
 * check, indistinguishable from a real, meaningful pass. This script is the belt-and-suspenders
 * mechanical check Playwright's own exit code does not provide.
 *
 * A "flaky" pass (`counts.retryPass > 0`) is NOT treated as a hard failure here -- Playwright's own
 * retry mechanism already decided the test is passing, and a CI provider's own job-level pass/fail
 * is Playwright's exit code, which this script does not override for that case. What this script
 * adds is VISIBILITY: an ordinary clean pass and a pass that only succeeded after a retry look
 * identical in a bare "green check" UI, and the Stage 10 acceptance criterion is explicit that a
 * flaky pass "cannot appear as an ordinary clean pass." The job summary table and the `::warning::`
 * annotation are what make that distinction visible without demanding a human dig into report
 * artifacts. `counts.quarantined` gets the same summary/annotation treatment (informational, not
 * blocking) -- a quarantined test is already excluded from `smoke`/`regression` selections by tag
 * conflict (`quality/tag-taxonomy.yaml`), so seeing one appear at all is itself worth a human's
 * attention.
 *
 * Usage:
 *   pnpm exec tsx playwright-framework/cli/ci-summary.ts                 summarize the most recently
 *                                                                         completed run report on disk
 *   pnpm exec tsx playwright-framework/cli/ci-summary.ts --run-id <id>   summarize a specific run
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadRunReportHistory } from "../coverage/runReportHistory.js";
import { summarizeRunReport } from "../reporting/ciSummary.js";

const ROOT = process.cwd();
const RUN_REPORTS_DIR = resolve(ROOT, "artifacts/playwright/runs/run-reports");

function parseArgs(argv: string[]): { runId: string | undefined } {
  let runId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run-id") {
      runId = argv[i + 1];
      i++;
    }
  }
  return { runId };
}

function main(): void {
  const { runId: requestedRunId } = parseArgs(process.argv.slice(2));

  const history = loadRunReportHistory(RUN_REPORTS_DIR);
  if (history.reports.length === 0) {
    console.error(`ci-summary: no run reports found under ${RUN_REPORTS_DIR} -- nothing to summarize. Failing closed: a CI step that expected a real Playwright invocation to have just run found no evidence one did.`);
    process.exit(1);
  }

  const targetReport = requestedRunId
    ? history.reports.find((r) => r.runId === requestedRunId)
    : [...history.reports].sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0];

  if (!targetReport) {
    console.error(`ci-summary: no run report found for run ID "${requestedRunId}".`);
    process.exit(1);
  }

  const result = summarizeRunReport(targetReport);

  console.log(result.markdownSummary);
  for (const annotation of result.annotations) console.log(annotation);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, result.markdownSummary + "\n", "utf-8");
  }

  if (result.isZeroTestRun) {
    process.exit(1);
  }
}

main();
