// Stage 11 final-audit Finding M1 (2026-09-11) / DEC-033 (2026-09-14) -- shared test helper for
// invoking playwright-framework/cli/run-tests.ts as a real child process, the same way `pnpm
// pw:run` does. Mirrors the pattern tests/hooks/runHook.ts established for the .claude/hooks/*.mjs
// scripts: main() in run-tests.ts is a top-to-bottom CLI script (no exported function to import
// and call directly for its production/mutation preflight, which is inlined -- see the spec's own
// comment block on why the pure sub-pieces it delegates to, like parseRunArgs and
// productionGuard's assertMutationAllowed, are unit-tested directly while this orchestration layer
// is exercised via its real, observable CLI behavior: exit code and printed output).
//
// Every invocation here uses either a nonexistent/never-matching production hostname preflight
// check (which fails closed, before any Playwright test would ever be spawned) or --preview
// (which never spawns Playwright at all) -- so these tests never launch a browser or touch the
// live app, and are safe to run in CI without a running dev server.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd());
const RUN_TESTS_SCRIPT = resolve(REPO_ROOT, "playwright-framework/cli/run-tests.ts");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");

export interface RunTestsCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `tsx run-tests.ts <args>` as a real child process with a controlled environment. Any
 * ambient PLAYWRIGHT_ALLOW_PRODUCTION/PRODUCTION_HOSTNAMES/APP_URL in the calling process's own
 * env is deliberately NOT inherited (unlike runHook.ts's `...process.env` spread) so a test's
 * env overrides are the complete, exact picture -- a stray ambient var could otherwise silently
 * change which factor is "missing" and mask a regression.
 */
export function runTestsCli(args: string[], envOverrides: Record<string, string>): RunTestsCliResult {
  const { PATH } = process.env;
  const result = spawnSync(TSX_BIN, [RUN_TESTS_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { PATH, ...envOverrides },
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
