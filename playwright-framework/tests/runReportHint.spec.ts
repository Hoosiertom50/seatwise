import { test, expect } from "@playwright/test";
import { buildRunReportHint } from "../runner/runReportHint.js";

// Stage 06 AUDIT FINDING (locking regression test): `pw:run` used to print a confident
// "Run report: artifacts/playwright/runs/run-reports/<runId>.html (pnpm pw:report:run <runId> to
// open it)" hint UNCONDITIONALLY, regardless of whether a run report was actually written.
// Passing this CLI's own documented `--reporter <value>` flag (its own --help text recommends
// `--reporter list`) makes Playwright's CLI replace its whole configured reporter array with just
// that one reporter, silently disabling Stage 06's own normalizedReporter -- so no run-report
// JSON/HTML is written at all, yet the old code printed the hint anyway. Reproduced live: `pnpm
// pw:run "@readonly" --allow-production --reporter list` printed a hint pointing at a file that
// was never created. A future change that goes back to an unconditional hint must fail this test,
// not just an ad hoc live check.
test.describe("buildRunReportHint", () => {
  test("points to the real run report when the file actually exists", () => {
    const hint = buildRunReportHint("abc-123", undefined, true);
    expect(hint).toBe(
      "Run report: artifacts/playwright/runs/run-reports/abc-123.html (pnpm pw:report:run abc-123 to open it)",
    );
  });

  test("never claims a run report exists when the file was not actually written", () => {
    const hint = buildRunReportHint("abc-123", undefined, false);
    expect(hint).not.toContain("abc-123.html");
    expect(hint.toLowerCase()).toContain("no run report was generated");
  });

  test("explains WHY no report was written when --reporter was passed, naming the actual flag value", () => {
    const hint = buildRunReportHint("abc-123", "list", false);
    expect(hint).toContain("--reporter list");
    expect(hint).toContain("replaces Playwright's whole configured reporter array");
    expect(hint).not.toContain("abc-123.html");
  });

  test("still reports honestly (no fabricated file reference) when the file is missing for an unknown reason and no --reporter was passed", () => {
    const hint = buildRunReportHint("abc-123", undefined, false);
    expect(hint).toContain("check the output above");
    expect(hint).not.toContain("abc-123.html");
  });
});
