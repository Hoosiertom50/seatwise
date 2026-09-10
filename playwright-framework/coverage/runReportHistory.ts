/**
 * Stage 07 — reads every Stage 06 run report (artifacts/playwright/runs/run-reports/*.json) so the
 * suite-review can answer "last known execution result and age" (Section 10.3, item 11) and
 * "tests not executed within the configured freshness window" per test, without re-running
 * anything itself. Run reports are gitignored, ephemeral, per-invocation files (Stage 06) -- there
 * can be zero, one, or many of them on disk at review time, and this module treats all of that as
 * normal: a test simply has no execution history until a real `playwright test`/`pw:run`/`pw:test`
 * invocation happens to have covered it.
 *
 * A corrupt or schema-invalid run-report file is skipped (counted, never thrown) rather than
 * aborting the whole suite review over one bad artifact -- these files are regenerated constantly
 * and are not the suite review's own source of truth for anything except "did this test run, and
 * when, and how did it go."
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunReportSchema, type RunReport, type RunReportTest } from "../metadata/schemas.js";

export interface RunReportHistory {
  reports: RunReport[];
  /** Files under the run-reports directory that were not valid, parseable `RunReport` JSON --
   * disclosed, never silently dropped. */
  invalidFileCount: number;
}

export function loadRunReportHistory(runReportsDir: string): RunReportHistory {
  let entries: string[];
  try {
    entries = readdirSync(runReportsDir).filter((f) => f.endsWith(".json"));
  } catch {
    // Directory doesn't exist yet (no run has ever produced a report) -- an empty history, not an
    // error; every test will simply show "never executed".
    return { reports: [], invalidFileCount: 0 };
  }

  const reports: RunReport[] = [];
  let invalidFileCount = 0;
  for (const entry of entries) {
    try {
      const raw = readFileSync(join(runReportsDir, entry), "utf-8");
      const parsed = RunReportSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        reports.push(parsed.data);
      } else {
        invalidFileCount++;
      }
    } catch {
      invalidFileCount++;
    }
  }

  return { reports, invalidFileCount };
}

export interface LastKnownResult {
  status: string;
  runId: string;
  endedAt: string;
  ageDays: number;
}

export interface LatestRunReportEntry {
  runId: string;
  endedAt: string;
  ageDays: number;
  /** The full per-test record from the winning report -- steps, assertionCount,
   * successCheckpoints, and everything else Stage 06 captured, not just the summary fields
   * `LastKnownResult` exposes for coverage/freshness/health purposes. */
  test: RunReportTest;
}

/** The most recent (by the report's own `endedAt`) execution of `testId` across every report in
 * `history`, with the FULL Stage 06 `RunReportTest` record attached -- or `undefined` if no report
 * ever covered it. `now` is injectable for deterministic unit testing. */
export function latestRunReportEntryForTest(
  testId: string,
  history: RunReportHistory,
  now: Date = new Date(),
): LatestRunReportEntry | undefined {
  let best: { runId: string; endedAt: string; endedAtMs: number; test: RunReportTest } | undefined;
  for (const report of history.reports) {
    const test = report.tests.find((t) => t.testId === testId);
    if (!test) continue;
    const endedAtMs = Date.parse(report.endedAt);
    if (Number.isNaN(endedAtMs)) continue;
    if (!best || endedAtMs > best.endedAtMs) {
      best = { runId: report.runId, endedAt: report.endedAt, endedAtMs, test };
    }
  }
  if (!best) return undefined;
  const ageDays = Math.max(0, (now.getTime() - best.endedAtMs) / (1000 * 60 * 60 * 24));
  return { runId: best.runId, endedAt: best.endedAt, ageDays, test: best.test };
}

/** Projects `latestRunReportEntryForTest`'s result down to just the summary fields
 * `computeCoverage.ts`'s health/freshness classification needs. */
export function latestResultForTest(
  testId: string,
  history: RunReportHistory,
  now: Date = new Date(),
): LastKnownResult | undefined {
  const entry = latestRunReportEntryForTest(testId, history, now);
  if (!entry) return undefined;
  return { status: entry.test.status, runId: entry.runId, endedAt: entry.endedAt, ageDays: entry.ageDays };
}
