/**
 * Stage 06 audit fix -- the post-run "did a run report get written" message, split into its own
 * pure, side-effect-free module specifically so it can be unit-tested directly (mirrors why
 * `buildPlaywrightInvocation.ts` exists as its own module: `run-tests.ts` calls `main()`
 * unconditionally at load, matching every other CLI entrypoint in this repo, so nothing imports it
 * directly).
 *
 * AUDIT FINDING this closes: `run-tests.ts` used to print the "Run report: .../<runId>.html (pnpm
 * pw:report:run <runId> to open it)" hint UNCONDITIONALLY, regardless of whether Stage 06's
 * reporter actually produced one. Passing this CLI's own documented `--reporter <value>` flag (its
 * own --help text recommends `--reporter list`) makes Playwright's CLI replace its ENTIRE
 * configured reporter array with just that one reporter, silently disabling both the native html
 * reporter AND Stage 06's own normalizedReporter -- so no run-report JSON/HTML is written at all.
 * Reproduced live: `pnpm pw:run "@readonly" --allow-production --reporter list` printed a
 * confident hint pointing at a file that was never created.
 *
 * The fix: never claim the run report exists without checking. This function is a pure function
 * of whether the file actually exists (checked by the caller, `run-tests.ts`, via `existsSync`) --
 * never assumed from the mere fact that a run was attempted.
 */
export function buildRunReportHint(
  runId: string,
  reporterFlag: string | undefined,
  runReportHtmlExists: boolean,
): string {
  if (runReportHtmlExists) {
    return (
      `Run report: artifacts/playwright/runs/run-reports/${runId}.html ` +
      `(pnpm pw:report:run ${runId} to open it)`
    );
  }
  return (
    `No run report was generated for this invocation` +
    (reporterFlag
      ? ` (--reporter ${reporterFlag} replaces Playwright's whole configured reporter array, ` +
        `which is how the run report gets written -- omit --reporter to get one)`
      : ` (check the output above for a reporter error)`) +
    "."
  );
}
