/**
 * Stage 05 audit fix — builds the exact argv array `playwright-framework/cli/run-tests.ts` hands to
 * `execFileSync`, split into its own pure, side-effect-free module specifically so it can be
 * unit-tested directly (mirrors why `parseRunArgs.ts` exists as its own module: `run-tests.ts` calls
 * `main()` unconditionally at load, matching every other CLI entrypoint in this repo, so nothing
 * imports it directly).
 *
 * AUDIT FINDING this closes: `--grep` alone is not enough to keep "what preview shows" and "what
 * actually runs" in agreement (Stage 05's own acceptance criterion). `--grep` matches a compiled
 * pattern against every test's FULL TITLE across the whole `--project=chromium` project -- and an
 * UNTAGGED test (e.g. `e2e/tests/framework-health.spec.ts`, or anything under `e2e/tests/unit/**`)
 * carries no tags at all in its title. Any expression an untagged test can trivially satisfy (a bare
 * `NOT`, or an `OR` with a `NOT` branch -- e.g. this repo's own real `NOT @quarantined`) therefore
 * matches it too under `--grep`, even though `discoverAllTests()`/`evaluateExpression` (what preview
 * is built from) never considered it a candidate at all, because it was never declared through
 * `defineQualityTest`. Verified live against this repo's real suite before this fix: `--grep
 * '^(?!(?=.*@quarantined(?![A-Za-z0-9:_-])))'` alone matched 37 tests across 5 files, not the 2 real
 * tagged tests preview reported for the same expression.
 *
 * The fix: restrict the spawned invocation to exactly the matched tests' OWN spec files, passed as
 * positional arguments alongside `--grep`. Playwright then only ever discovers tests inside those
 * files in the first place, so an unrelated untagged file can never be pulled in merely because its
 * bare title happens to satisfy the compiled pattern -- `--grep` still does the real narrowing
 * *within* those files exactly as before. Re-verified live for the same case after the fix: passing
 * both matched files alongside the same pattern brings the direct `--grep --list` count back down to
 * exactly 2, matching preview.
 */

export interface BuildPlaywrightTestArgsInput {
  compiledPattern: string;
  /** Relative spec-file paths of every matched test (as `discoverAllTests()` reports them) --
   * duplicates (multiple matched tests in the same file) are expected and de-duplicated here. */
  matchedFilePaths: string[];
  workers?: number;
  repeatEach?: number;
  reporter?: string;
}

/** Builds the argv array (after the leading `"pnpm"`) for the real `playwright test` invocation.
 * Pure and deterministic: same input always produces the same argv, so this can be asserted on
 * directly without spawning a process or a browser. */
export function buildPlaywrightTestArgs(input: BuildPlaywrightTestArgsInput): string[] {
  const uniqueFiles = [...new Set(input.matchedFilePaths)];
  const args = [
    "exec",
    "playwright",
    "test",
    "--project=chromium",
    "--grep",
    input.compiledPattern,
    ...uniqueFiles,
  ];
  if (input.workers !== undefined) args.push("--workers", String(input.workers));
  if (input.repeatEach !== undefined) args.push("--repeat-each", String(input.repeatEach));
  if (input.reporter !== undefined) args.push("--reporter", input.reporter);
  return args;
}
