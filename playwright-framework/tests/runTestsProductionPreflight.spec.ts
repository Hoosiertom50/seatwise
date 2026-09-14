/**
 * Stage 11 final-audit Finding M1 (2026-09-11) / DEC-033 (2026-09-14) -- locking regression test.
 *
 * Before this fix, playwright-framework/cli/run-tests.ts's production preflight computed
 * "is a production read-only run allowed" from `args.allowProduction` alone -- the
 * `PLAYWRIGHT_ALLOW_PRODUCTION` environment variable was parsed by e2e/support/env.ts (and
 * genuinely available) but never actually consulted by this file, even though
 * PLAYWRIGHT_TESTING.md and this CLI's own --help/error text always described a two-factor gate.
 * `--allow-production` alone was therefore silently sufficient to read from a configured
 * production host -- a real doc/code mismatch (dormant in practice, since PRODUCTION_HOSTNAMES
 * defaults empty per DEC-005, but real).
 *
 * These tests spawn the real CLI (via runTestsCli.ts, the same pattern tests/hooks/runHook.ts uses
 * for the .claude/hooks/*.mjs scripts) and assert on its actual exit code and output, so a future
 * change that reverts to checking only one factor fails this suite immediately. Every case here
 * either fails closed before Playwright would ever be spawned, or uses --preview, so none of them
 * launch a browser or require a live app.
 */
import { expect, test } from "@playwright/test";
import { runTestsCli } from "./runTestsCli";

const PRODUCTION_ENV = { PRODUCTION_HOSTNAMES: "localhost", APP_URL: "http://localhost:3000" };

test.describe("run-tests.ts production preflight -- requires BOTH factors (Finding M1 / DEC-033)", () => {
  test("--allow-production flag alone, with PLAYWRIGHT_ALLOW_PRODUCTION unset, is refused", () => {
    const result = runTestsCli(["--selection", "readonly", "--allow-production"], {
      ...PRODUCTION_ENV,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/configured production host/);
    expect(result.stderr).toMatch(/BOTH --allow-production.*AND PLAYWRIGHT_ALLOW_PRODUCTION=1/);
    expect(result.stderr).toMatch(/missing: PLAYWRIGHT_ALLOW_PRODUCTION=1 in the environment/);
  });

  test("PLAYWRIGHT_ALLOW_PRODUCTION=1 alone, without the --allow-production flag, is refused", () => {
    const result = runTestsCli(["--selection", "readonly"], {
      ...PRODUCTION_ENV,
      PLAYWRIGHT_ALLOW_PRODUCTION: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/configured production host/);
    expect(result.stderr).toMatch(/missing: the --allow-production flag on this invocation/);
  });

  test("neither factor present is refused, naming both as missing", () => {
    const result = runTestsCli(["--selection", "readonly"], { ...PRODUCTION_ENV });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /missing: the --allow-production flag on this invocation and PLAYWRIGHT_ALLOW_PRODUCTION=1 in the environment/,
    );
  });

  test("both factors present is allowed for a read-only selection (preview reflects this)", () => {
    const result = runTestsCli(["--selection", "readonly", "--allow-production", "--preview"], {
      ...PRODUCTION_ENV,
      PLAYWRIGHT_ALLOW_PRODUCTION: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /both --allow-production and PLAYWRIGHT_ALLOW_PRODUCTION=1 are set, so running it for real would be allowed/,
    );
  });

  test("a mutating selection is refused unconditionally, even with both factors present", () => {
    const result = runTestsCli(["@mutating", "--allow-production"], {
      ...PRODUCTION_ENV,
      PLAYWRIGHT_ALLOW_PRODUCTION: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing to run/);
    expect(result.stderr).toMatch(/@mutating test/);
    expect(result.stderr).not.toMatch(/missing:/); // never framed as "just needs a factor" -- it's unconditional
  });

  test("preview mode for a non-production target never mentions the production guard at all", () => {
    const result = runTestsCli(["--selection", "readonly", "--preview"], {
      PRODUCTION_HOSTNAMES: "",
      APP_URL: "http://localhost:3000",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/configured production host/);
  });
});
