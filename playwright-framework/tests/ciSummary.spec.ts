// Stage 10 -- summarizeRunReport (playwright-framework/reporting/ciSummary.ts), the pure logic
// behind `pnpm exec tsx playwright-framework/cli/ci-summary.ts`. Every fixture is a plain, fully-
// typed RunReport object (never parsed through the zod schema here -- schemas.spec.ts covers that
// separately), following the exact fixture shape classifyFailure.spec.ts already established.
import { test, expect } from "@playwright/test";
import { summarizeRunReport } from "../reporting/ciSummary.js";
import type { RunReport } from "../metadata/schemas.js";

function baseCounts(overrides: Partial<RunReport["counts"]> = {}): RunReport["counts"] {
  return {
    initialPass: 0,
    retryPass: 0,
    consistentFailure: 0,
    timeout: 0,
    skipped: 0,
    expectedFailure: 0,
    quarantined: 0,
    setupFailure: 0,
    ...overrides,
  };
}

function baseReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: "1.0.0",
    runId: "run-fixture-1",
    generatedAt: "2026-09-11T12:00:00.000Z",
    startedAt: "2026-09-11T11:59:00.000Z",
    endedAt: "2026-09-11T12:00:00.000Z",
    durationMs: 60000,
    initiator: "test-fixture",
    environment: "local",
    baseUrl: "http://localhost:3000",
    gitCommit: "deadbeef",
    workingTreeClean: true,
    playwrightVersion: "1.63.0",
    nodeVersion: "v22.22.2",
    operatingSystem: "linux",
    browserProjects: ["chromium"],
    workers: 1,
    retries: 0,
    tagExpression: "@readonly OR @mutating",
    selectionSummary: { matchedCount: 2, excludedCount: 0 },
    counts: baseCounts(),
    tests: [],
    ...overrides,
  };
}

test.describe("summarizeRunReport -- zero-test detection", () => {
  test("a report with every count at zero is flagged as a zero-test run and treated as a hard failure", () => {
    const report = baseReport({ counts: baseCounts(), selectionSummary: { matchedCount: 0, excludedCount: 2 } });
    const result = summarizeRunReport(report);
    expect(result.total).toBe(0);
    expect(result.isZeroTestRun).toBe(true);
    expect(result.annotations.some((a) => a.startsWith("::error::") && a.includes("ZERO tests"))).toBe(true);
    expect(result.markdownSummary).toContain("ZERO TESTS EXECUTED");
  });

  test("a report with at least one real outcome (even just a skip) is NOT a zero-test run", () => {
    const report = baseReport({ counts: baseCounts({ skipped: 1 }) });
    const result = summarizeRunReport(report);
    expect(result.isZeroTestRun).toBe(false);
    expect(result.annotations.some((a) => a.includes("ZERO tests"))).toBe(false);
  });
});

test.describe("summarizeRunReport -- flaky visibility (cannot look like an ordinary clean pass)", () => {
  test("a report with only initialPass counts is reported as a clean pass with no flaky annotation", () => {
    const report = baseReport({ counts: baseCounts({ initialPass: 2 }) });
    const result = summarizeRunReport(report);
    expect(result.flaky).toBe(0);
    expect(result.annotations.some((a) => a.includes("flaky"))).toBe(false);
    expect(result.markdownSummary).toContain("Clean pass.");
    expect(result.markdownSummary).not.toContain("flaky");
  });

  test("a report with any retryPass count is flagged flaky via a warning annotation and a distinct summary line, not folded into an ordinary clean pass", () => {
    const report = baseReport({ counts: baseCounts({ initialPass: 1, retryPass: 1 }) });
    const result = summarizeRunReport(report);
    expect(result.flaky).toBe(1);
    expect(result.isZeroTestRun).toBe(false);
    expect(result.annotations.some((a) => a.startsWith("::warning::") && a.includes("retry (flaky)"))).toBe(true);
    expect(result.markdownSummary).toContain("required a retry (flaky)");
    expect(result.markdownSummary).not.toContain("**Clean pass.**");
  });
});

test.describe("summarizeRunReport -- quarantined visibility", () => {
  test("a report with a quarantined test executed gets an informational warning, not a hard failure", () => {
    const report = baseReport({ counts: baseCounts({ initialPass: 1, quarantined: 1 }) });
    const result = summarizeRunReport(report);
    expect(result.quarantined).toBe(1);
    expect(result.isZeroTestRun).toBe(false);
    expect(result.annotations.some((a) => a.startsWith("::warning::") && a.includes("quarantined"))).toBe(true);
  });
});

test.describe("summarizeRunReport -- real failures", () => {
  test("consistent failures, timeouts, and setup failures are all counted toward 'failed' and produce an error annotation", () => {
    const report = baseReport({ counts: baseCounts({ consistentFailure: 1, timeout: 1, setupFailure: 1 }) });
    const result = summarizeRunReport(report);
    expect(result.failed).toBe(3);
    expect(result.annotations.some((a) => a.startsWith("::error::") && a.includes("3 test(s) failed"))).toBe(true);
    expect(result.markdownSummary).toContain("3 test(s) failed.");
  });

  test("a failed run is never described as a clean pass, even when it also has a flaky retry", () => {
    const report = baseReport({ counts: baseCounts({ consistentFailure: 1, retryPass: 1 }) });
    const result = summarizeRunReport(report);
    expect(result.markdownSummary).toContain("1 test(s) failed.");
    expect(result.markdownSummary).not.toContain("**Clean pass.**");
  });
});

test.describe("summarizeRunReport -- markdown summary content", () => {
  test("includes the run ID, selection expression, and matched/excluded counts", () => {
    const report = baseReport({ runId: "abc-123", tagExpression: "@risk:critical", selectionSummary: { matchedCount: 5, excludedCount: 10 }, counts: baseCounts({ initialPass: 5 }) });
    const result = summarizeRunReport(report);
    expect(result.markdownSummary).toContain("abc-123");
    expect(result.markdownSummary).toContain("@risk:critical");
    expect(result.markdownSummary).toContain("matched 5, excluded 10");
  });
});
