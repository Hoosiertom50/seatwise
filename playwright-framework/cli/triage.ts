#!/usr/bin/env node
/**
 * Stage 09 — the failure-triage CLI (spec Section 10.4, `/pw-triage-failures`): reads one already-
 * completed Stage 06 run report BY RUN ID and classifies every real failure in it against Section
 * 10.4's 7 categories, writing a schema-validated maintenance report to
 * artifacts/playwright/maintenance/<reportId>.{json,html}.
 *
 * "Artifact collection by run ID without rerunning first" (Stage 09 task) is exactly what this CLI
 * does and does not do: it never launches Playwright or a browser, only reads whatever Stage 06
 * run-report JSON already exists on disk (via runReportHistory.ts, the same Stage 07 suite-review
 * already depends on) plus the latest Stage 07 suite review (for sibling-test cross-reference) and
 * quality/failure-classifications.yaml (the hand-authored tier, DEC-028).
 *
 * Usage:
 *   pnpm pw:triage                 triage the most recently completed run report on disk
 *   pnpm pw:triage --run-id <id>   triage a specific run report by its run ID
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";

import { loadFailureClassifications, MetadataValidationError } from "../metadata/loaders.js";
import { MaintenanceReportSchema, SuiteReviewSchema, type MaintenanceFinding, type SuiteReview } from "../metadata/schemas.js";
import { loadRunReportHistory } from "../coverage/runReportHistory.js";
import { findMostRecentSuiteReviewPath } from "../coverage/diffSuiteReviews.js";
import { classifyFailure } from "../triage/classifyFailure.js";
import { renderMaintenanceReportHtml } from "../reporting/renderMaintenanceReportHtml.js";
import { FRAMEWORK_VERSION } from "../version.js";
import { gitInfo } from "../gitInfo.js";

const ROOT = process.cwd();
const RUN_REPORTS_DIR = resolve(ROOT, "artifacts/playwright/runs/run-reports");
const SUITE_REVIEWS_DIR = resolve(ROOT, "artifacts/playwright/runs/suite-reviews");
const MAINTENANCE_DIR = resolve(ROOT, "artifacts/playwright/maintenance");

const FAILING_STATUSES = new Set(["consistent-failure", "timeout", "setup-failure"]);

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

function loadLatestSuiteReview(): SuiteReview | undefined {
  const path = findMostRecentSuiteReviewPath(SUITE_REVIEWS_DIR);
  if (!path) return undefined;
  try {
    const parsed = SuiteReviewSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (parsed.success) return parsed.data;
    console.warn(`WARNING: most recent suite review at ${path} failed schema validation -- triaging without sibling-test cross-reference.`);
  } catch {
    console.warn(`WARNING: could not read/parse the most recent suite review at ${path} -- triaging without sibling-test cross-reference.`);
  }
  return undefined;
}

function main(): void {
  const { runId: requestedRunId } = parseArgs(process.argv.slice(2));

  const history = loadRunReportHistory(RUN_REPORTS_DIR);
  if (history.invalidFileCount > 0) {
    console.warn(`WARNING: ${history.invalidFileCount} file(s) under ${relative(ROOT, RUN_REPORTS_DIR)} were not valid run-report JSON and were skipped.`);
  }
  if (history.reports.length === 0) {
    console.error(`No run reports found under ${relative(ROOT, RUN_REPORTS_DIR)} -- run \`pnpm pw:run\` at least once before triaging.`);
    process.exit(1);
  }

  const targetReport = requestedRunId
    ? history.reports.find((r) => r.runId === requestedRunId)
    : [...history.reports].sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0];

  if (!targetReport) {
    console.error(`No run report found for run ID "${requestedRunId}".`);
    process.exit(1);
  }

  let failureClassifications;
  try {
    failureClassifications = loadFailureClassifications(resolve(ROOT, "quality/failure-classifications.yaml"));
  } catch (err) {
    if (err instanceof MetadataValidationError) {
      console.error(`Triage FAILED -- could not load quality/failure-classifications.yaml:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const suiteReview = loadLatestSuiteReview();

  const failingTests = targetReport.tests.filter((t) => FAILING_STATUSES.has(t.status));

  const findings: MaintenanceFinding[] = failingTests.map((failingTest) =>
    classifyFailure({
      failingTest,
      runId: targetReport.runId,
      runReportHistory: history,
      suiteReview,
      failureClassifications,
    }),
  );

  const reportId = randomUUID();
  const { gitCommit, workingTreeClean } = gitInfo();
  const report = {
    schemaVersion: "1.0.0" as const,
    reportId,
    generatedAt: new Date().toISOString(),
    frameworkVersion: FRAMEWORK_VERSION,
    gitCommit,
    workingTreeClean,
    sourceRunId: targetReport.runId,
    findings,
  };

  const validated = MaintenanceReportSchema.safeParse(report);
  if (!validated.success) {
    console.error(
      `Maintenance report FAILED its own schema validation -- this is a bug in triage.ts/classifyFailure.ts, not something to silently coerce past:\n` +
        validated.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
    process.exit(1);
  }

  mkdirSync(MAINTENANCE_DIR, { recursive: true });
  const jsonPath = resolve(MAINTENANCE_DIR, `${reportId}.json`);
  writeFileSync(jsonPath, JSON.stringify(validated.data, null, 2) + "\n", "utf-8");

  const htmlPath = resolve(MAINTENANCE_DIR, `${reportId}.html`);
  try {
    writeFileSync(htmlPath, renderMaintenanceReportHtml(validated.data), "utf-8");
  } catch (err) {
    console.error(`\nMaintenance-report HTML generation failed (the JSON at ${relative(ROOT, jsonPath)} was still written):\n${err instanceof Error ? err.stack : err}`);
  }

  console.log(`Maintenance report ${reportId} written for run ${targetReport.runId}:`);
  console.log(`  JSON: ${relative(ROOT, jsonPath)}`);
  if (existsSync(htmlPath)) console.log(`  HTML: ${relative(ROOT, htmlPath)}`);

  console.log(`\n${failingTests.length} failure(s) triaged.`);
  const byClassification = new Map<string, number>();
  for (const f of findings) byClassification.set(f.classification, (byClassification.get(f.classification) ?? 0) + 1);
  for (const [classification, count] of byClassification) {
    console.log(`  ${classification}: ${count}`);
  }
  const repairCandidates = findings.filter((f) => f.repairAllowed);
  console.log(`${repairCandidates.length} finding(s) are repair candidates (still require explicit human confirmation via /pw-repair-test).`);
}

main();
