import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRunReportHistory,
  latestResultForTest,
  latestRunReportEntryForTest,
} from "../coverage/runReportHistory.js";
import type { RunReport } from "../metadata/schemas.js";

function makeReport(overrides: Partial<RunReport> & { runId: string; endedAt: string }): RunReport {
  return {
    schemaVersion: "1.0.0",
    generatedAt: overrides.endedAt,
    startedAt: overrides.endedAt,
    durationMs: 100,
    initiator: "test",
    environment: "local",
    baseUrl: "http://localhost:3000",
    gitCommit: "abc",
    workingTreeClean: true,
    playwrightVersion: "1.63.0",
    nodeVersion: "v22.0.0",
    operatingSystem: "linux",
    browserProjects: ["chromium"],
    workers: 1,
    retries: 0,
    tagExpression: "",
    selectionSummary: { matchedCount: 1, excludedCount: 0 },
    counts: {
      initialPass: 1,
      retryPass: 0,
      consistentFailure: 0,
      timeout: 0,
      skipped: 0,
      expectedFailure: 0,
      quarantined: 0,
      setupFailure: 0,
    },
    tests: [],
    ...overrides,
  };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "run-report-history-test-"));
}

test.describe("loadRunReportHistory", () => {
  test("returns an empty history, not an error, when the directory does not exist", () => {
    const history = loadRunReportHistory("/nonexistent/path/for/this/test");
    expect(history.reports).toEqual([]);
    expect(history.invalidFileCount).toBe(0);
  });

  test("skips a corrupt/invalid JSON file rather than throwing, and counts it", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "not-json.json"), "{ this is not valid json");
      writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ foo: "bar" }));
      const valid = makeReport({ runId: "r1", endedAt: "2026-01-01T00:00:00.000Z" });
      writeFileSync(join(dir, "valid.json"), JSON.stringify(valid));

      const history = loadRunReportHistory(dir);
      expect(history.reports).toHaveLength(1);
      expect(history.reports[0].runId).toBe("r1");
      expect(history.invalidFileCount).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("latestRunReportEntryForTest / latestResultForTest", () => {
  test("picks the report with the most recent endedAt when several cover the same test", () => {
    const older = makeReport({
      runId: "older",
      endedAt: "2026-01-01T00:00:00.000Z",
      tests: [
        {
          testId: "t1",
          title: "t1",
          filePath: "e2e/tests/x.spec.ts",
          line: 1,
          tags: [],
          requirementIds: [],
          status: "consistent-failure",
          durationMs: 1,
          attempts: 1,
          steps: [],
          assertionCount: 0,
          successCheckpoints: [],
        },
      ],
    });
    const newer = makeReport({
      runId: "newer",
      endedAt: "2026-01-05T00:00:00.000Z",
      tests: [
        {
          testId: "t1",
          title: "t1",
          filePath: "e2e/tests/x.spec.ts",
          line: 1,
          tags: [],
          requirementIds: [],
          status: "initial-pass",
          durationMs: 1,
          attempts: 1,
          steps: [{ title: "Arrange", category: "test.step", durationMs: 1, status: "passed" }],
          assertionCount: 3,
          successCheckpoints: [],
        },
      ],
    });

    const history = { reports: [older, newer], invalidFileCount: 0 };
    const now = new Date("2026-01-10T00:00:00.000Z");

    const summary = latestResultForTest("t1", history, now);
    expect(summary?.status).toBe("initial-pass"); // the newer report, not the older failure
    expect(summary?.runId).toBe("newer");
    expect(summary?.ageDays).toBeCloseTo(5, 1);

    const full = latestRunReportEntryForTest("t1", history, now);
    expect(full?.test.assertionCount).toBe(3);
    expect(full?.test.steps).toHaveLength(1);
  });

  test("returns undefined when no report ever covered the test", () => {
    const history = { reports: [makeReport({ runId: "r1", endedAt: "2026-01-01T00:00:00.000Z" })], invalidFileCount: 0 };
    expect(latestResultForTest("never-seen", history)).toBeUndefined();
    expect(latestRunReportEntryForTest("never-seen", history)).toBeUndefined();
  });
});
