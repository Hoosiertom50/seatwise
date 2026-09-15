#!/usr/bin/env node
/**
 * Stage 07 — the suite-review CLI (spec Section 10.3): the one command that assembles every
 * mechanical/hand-authored judgment this stage built into a single validated `SuiteReview` document
 * and renders it to JSON + HTML, mirroring exactly how Stage 06's reporter/CLI pair produces a run
 * report (discover -> compute -> validate against a versioned schema -> write JSON -> render HTML).
 *
 * Unlike a run report, this is not a Playwright reporter -- there is nothing to execute here, only
 * to read (the real discovered test suite, the governance YAML files, and whatever Stage 06 run-
 * report history already exists on disk) and compute from. Running `pnpm pw:review` never launches
 * a browser or a test.
 *
 * Usage:
 *   pnpm pw:review                        generate a new suite review from the current repo state
 *   pnpm pw:review --freshness-window-days 30   override the default freshness window (14 days)
 *
 * Steps, in order:
 *   1. Statically discover every real e2e/tests/**\/*.spec.ts test (discoverAllApplicationTests,
 *      the same Stage 06 shared helper the reporter uses).
 *   2. Load quality/requirements.yaml, quality/tag-taxonomy.yaml, quality/test-value-model.yaml,
 *      quality/value-overrides.yaml, quality/test-evaluations.yaml -- the same loaders/schemas
 *      every earlier stage already built and unit-tested.
 *   3. Load whatever Stage 06 run-report history exists under artifacts/playwright/runs/run-
 *      reports/ (runReportHistory.ts) -- zero, one, or many files, never required.
 *   4. Compute requirement/risk-weighted/dimension coverage (computeCoverage.ts) and duplicate
 *      candidates (detectDuplicates.ts).
 *   5. Evaluate every discovered test's value and quality criteria (evaluateTest.ts, DEC-021's
 *      mechanical/hand-authored/forced-needs-human-review split) and turn those judgments into
 *      ScoreResults (computeScore.ts), applying any human override on file (applyOverride.ts).
 *   6. Build the prioritized review queue (buildReviewQueue.ts).
 *   7. Diff against the most recently generated prior suite review on disk, if one exists
 *      (diffSuiteReviews.ts).
 *   8. Validate the assembled document against SuiteReviewSchema -- a schema violation here is a
 *      bug in this CLI, not something to silently coerce past.
 *   9. Write JSON + HTML to artifacts/playwright/runs/suite-reviews/<reviewId>.{json,html}.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";

import { discoverAllApplicationTests } from "../validation/discoverAllTests.js";
import {
  loadRequirements,
  loadTagTaxonomy,
  loadTestValueModel,
  loadValueOverrides,
  loadTestEvaluations,
  MetadataValidationError,
} from "../metadata/loaders.js";
import { SuiteReviewSchema, type SuiteReview, type SuiteReviewTestEntry } from "../metadata/schemas.js";
import { loadRunReportHistory, latestRunReportEntryForTest } from "../coverage/runReportHistory.js";
import {
  computeRequirementCoverage,
  computeRiskWeightedCoverage,
  computeDimensionCoverage,
  classifyTestHealth,
  type CoverageTestInput,
} from "../coverage/computeCoverage.js";
import { detectDuplicates, type DuplicateDetectionTestInput } from "../coverage/detectDuplicates.js";
import { evaluateTestQuality, evaluateTestValue, type EvaluationTestInput } from "../evaluation/evaluateTest.js";
import { computeScore } from "../scoring/computeScore.js";
import { bandForValueScore } from "../scoring/bands.js";
import { applyOverride } from "../scoring/applyOverride.js";
import { buildReviewQueue } from "../coverage/buildReviewQueue.js";
import { diffSuiteReviews, findMostRecentSuiteReviewPath } from "../coverage/diffSuiteReviews.js";
import { renderSuiteReviewHtml } from "../reporting/renderSuiteReviewHtml.js";
import { FRAMEWORK_VERSION } from "../version.js";
import { gitInfo } from "../gitInfo.js";

const ROOT = process.cwd();
const E2E_TESTS_DIR = resolve(ROOT, "e2e/tests");
const RUN_REPORTS_DIR = resolve(ROOT, "artifacts/playwright/runs/run-reports");
const SUITE_REVIEWS_DIR = resolve(ROOT, "artifacts/playwright/runs/suite-reviews");

// No config file yet defines this (there is no quality/config.yaml -- DEC-009 leaves priority/
// freshness policy for a human to set later); 14 days is a reasonable default for a suite this
// size, overridable per-invocation via --freshness-window-days since it is a policy choice, not a
// structural constant.
const DEFAULT_FRESHNESS_WINDOW_DAYS = 14;

function parseArgs(argv: string[]): { freshnessWindowDays: number } {
  let freshnessWindowDays = DEFAULT_FRESHNESS_WINDOW_DAYS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--freshness-window-days") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        console.error(`--freshness-window-days must be a positive integer, got "${argv[i + 1]}"`);
        process.exit(1);
      }
      freshnessWindowDays = value;
      i++;
    }
  }
  return { freshnessWindowDays };
}

function distributionOf(totals: number[], bandEdges: { label: string; min: number; max: number }[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const edge of bandEdges) dist[edge.label] = 0;
  for (const total of totals) {
    const edge = bandEdges.find((e) => total >= e.min && total <= e.max);
    if (edge) dist[edge.label]++;
  }
  return dist;
}

const QUALITY_BAND_EDGES = [
  { label: "90-100", min: 90, max: 100 },
  { label: "75-89", min: 75, max: 89 },
  { label: "50-74", min: 50, max: 74 },
  { label: "25-49", min: 25, max: 49 },
  { label: "0-24", min: 0, max: 24 },
];

function main(): void {
  const { freshnessWindowDays } = parseArgs(process.argv.slice(2));

  // --- 1: discover -----------------------------------------------------------------------------
  const { tests: discovered, parseErrorCount } = discoverAllApplicationTests(E2E_TESTS_DIR);
  if (discovered.length === 0) {
    console.error(
      `No application tests discovered under ${relative(ROOT, E2E_TESTS_DIR)} -- nothing to review.`,
    );
    process.exit(1);
  }

  // --- 2: load governance files ----------------------------------------------------------------
  let requirements, taxonomy, valueModel, valueOverrides, testEvaluations;
  try {
    requirements = loadRequirements(resolve(ROOT, "quality/requirements.yaml"));
    taxonomy = loadTagTaxonomy(resolve(ROOT, "quality/tag-taxonomy.yaml"));
    valueModel = loadTestValueModel(resolve(ROOT, "quality/test-value-model.yaml"));
    valueOverrides = loadValueOverrides(resolve(ROOT, "quality/value-overrides.yaml"));
    testEvaluations = loadTestEvaluations(resolve(ROOT, "quality/test-evaluations.yaml"));
  } catch (err) {
    if (err instanceof MetadataValidationError) {
      console.error(`Suite review FAILED -- could not load governance files:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (testEvaluations.modelVersion !== valueModel.modelVersion) {
    console.warn(
      `WARNING: quality/test-evaluations.yaml was authored against value model version ` +
        `"${testEvaluations.modelVersion}", but the live model is "${valueModel.modelVersion}" -- ` +
        `Section 8.6 requires every hand-authored evaluation be reconsidered after a model change. ` +
        `Every entry is being used as-is; re-author quality/test-evaluations.yaml against the new model.`,
    );
  }

  // --- 3: run-report history ---------------------------------------------------------------------
  const runReportHistory = loadRunReportHistory(RUN_REPORTS_DIR);
  if (runReportHistory.invalidFileCount > 0) {
    console.warn(
      `WARNING: ${runReportHistory.invalidFileCount} file(s) under ${relative(ROOT, RUN_REPORTS_DIR)} ` +
        `were not valid run-report JSON and were skipped.`,
    );
  }

  const evaluationInputs: EvaluationTestInput[] = discovered.map((d) => ({
    testId: d.metadata.id,
    filePath: d.filePath, // absolute -- evaluateTest.ts reads source text from this path
    tags: d.metadata.tags,
    requirementIds: d.metadata.requirementIds,
    objective: d.metadata.objective,
  }));

  // --- 4: coverage + duplicates ------------------------------------------------------------------
  const coverageTestInputs: CoverageTestInput[] = evaluationInputs.map((t) => ({
    testId: t.testId,
    tags: t.tags,
    requirementIds: t.requirementIds,
  }));

  const now = new Date();
  const latestEntryByTestId = new Map(
    evaluationInputs.map((t) => [t.testId, latestRunReportEntryForTest(t.testId, runReportHistory, now)]),
  );
  const healthByTestId = new Map(
    evaluationInputs.map((t) => {
      const entry = latestEntryByTestId.get(t.testId);
      const lastKnownResult = entry
        ? { status: entry.test.status, runId: entry.runId, endedAt: entry.endedAt, ageDays: entry.ageDays }
        : undefined;
      return [t.testId, classifyTestHealth(t.tags, lastKnownResult, freshnessWindowDays)];
    }),
  );

  const { bucket: requirementCoverageBucket, details: requirementDetails } = computeRequirementCoverage(
    requirements,
    coverageTestInputs,
    healthByTestId,
  );
  const { bucket: riskWeightedCoverageBucket } = computeRiskWeightedCoverage(
    requirementDetails,
    coverageTestInputs,
  );
  const dimensionCoverage = computeDimensionCoverage(taxonomy, coverageTestInputs);

  const duplicateInputs: DuplicateDetectionTestInput[] = evaluationInputs.map((t) => ({
    testId: t.testId,
    tags: t.tags,
    requirementIds: t.requirementIds,
    objective: t.objective,
  }));
  const duplicateCandidates = detectDuplicates(duplicateInputs);

  // --- 5: evaluate every test, compute + override scores ------------------------------------------
  const suiteReviewTests: SuiteReviewTestEntry[] = discovered.map((d) => {
    const testInput = evaluationInputs.find((t) => t.testId === d.metadata.id)!;
    const sourceText = readFileSync(d.filePath, "utf-8");
    const latestEntry = latestEntryByTestId.get(d.metadata.id);

    const ctx = {
      test: testInput,
      sourceText,
      allTests: evaluationInputs,
      requirements,
      testEvaluations,
      latestRunReportEntry: latestEntry,
    };

    const qualityJudgments = evaluateTestQuality(ctx);
    const valueJudgments = evaluateTestValue(ctx);

    let qualityScore = computeScore({
      modelVersion: valueModel.modelVersion,
      criteria: valueModel.qualityCriteria,
      judgments: qualityJudgments,
    });
    let valueScore = computeScore({
      modelVersion: valueModel.modelVersion,
      criteria: valueModel.valueCriteria,
      judgments: valueJudgments,
      band: (total) => bandForValueScore(total, valueModel),
    });

    // An override entry doesn't itself say whether it targets the value or quality model. A
    // criterion-score override is unambiguous -- it applies wherever that criterionId actually
    // lives. A total-score override is ambiguous between the two; by convention here it applies to
    // the VALUE score only, since Section 8.4's bands and release-readiness language are value-
    // score concepts -- a quality total-score override is not a case this repo's real
    // value-overrides.yaml has needed yet (it is empty today).
    for (const override of valueOverrides.overrides) {
      if (override.testId !== d.metadata.id) continue;
      if (override.overrideType === "criterion-score") {
        if (qualityScore.criteria.some((c) => c.criterionId === override.criterionId)) {
          qualityScore = applyOverride(qualityScore, override);
        } else if (valueScore.criteria.some((c) => c.criterionId === override.criterionId)) {
          valueScore = applyOverride(valueScore, override, (total) => bandForValueScore(total, valueModel));
        }
      } else {
        valueScore = applyOverride(valueScore, override, (total) => bandForValueScore(total, valueModel));
      }
    }

    const health = healthByTestId.get(d.metadata.id)!;
    const recommendations: string[] = [];
    if (valueScore.provisional) {
      recommendations.push(
        "Value score is provisional -- one or more criteria still need human review (see the criterion breakdown above).",
      );
    }
    if (qualityScore.provisional) {
      recommendations.push(
        "Quality score is provisional -- one or more criteria still need human review (see the criterion breakdown above).",
      );
    }
    if (health === "never-executed") {
      recommendations.push("Has never been executed -- run it at least once before relying on this review.");
    }

    return {
      testId: d.metadata.id,
      title: d.metadata.title,
      filePath: relative(ROOT, d.filePath),
      line: d.line,
      tags: d.metadata.tags,
      requirementIds: d.metadata.requirementIds,
      objective: d.metadata.objective,
      expectedOutcome: d.metadata.expectedOutcome,
      valueScore,
      qualityScore,
      lastKnownResult: latestEntry
        ? {
            status: latestEntry.test.status,
            runId: latestEntry.runId,
            endedAt: latestEntry.endedAt,
            ageDays: latestEntry.ageDays,
            staleBeyondFreshnessWindow: health === "stale",
            durationMs: latestEntry.test.durationMs,
          }
        : undefined,
      quarantined: d.metadata.tags.includes("@quarantined"),
      recommendations,
    };
  });

  // --- 6: review queue -----------------------------------------------------------------------
  const reviewQueue = buildReviewQueue({
    tests: suiteReviewTests,
    requirementDetails,
    duplicateCandidates,
  });

  // --- 7: diff against the previous review, if any --------------------------------------------
  let previousReview: SuiteReview | undefined;
  const previousPath = findMostRecentSuiteReviewPath(SUITE_REVIEWS_DIR);
  if (previousPath) {
    try {
      const parsed = SuiteReviewSchema.safeParse(JSON.parse(readFileSync(previousPath, "utf-8")));
      if (parsed.success) previousReview = parsed.data;
      else console.warn(`WARNING: previous suite review at ${previousPath} failed schema validation -- ignoring it.`);
    } catch {
      console.warn(`WARNING: could not read/parse previous suite review at ${previousPath} -- ignoring it.`);
    }
  }

  const reviewId = randomUUID();
  const generatedAt = new Date().toISOString();
  const changesFromPreviousReview = diffSuiteReviews(previousReview, {
    reviewId,
    generatedAt,
    tests: suiteReviewTests,
  });

  const { gitCommit, workingTreeClean } = gitInfo();

  const review: SuiteReview = {
    schemaVersion: "1.0.0",
    reviewId,
    generatedAt,
    frameworkVersion: FRAMEWORK_VERSION,
    gitCommit,
    workingTreeClean,
    valueModelVersion: valueModel.modelVersion,
    freshnessWindowDays,
    parseErrorCount,
    requirementCoverage: requirementCoverageBucket,
    riskWeightedCoverage: riskWeightedCoverageBucket,
    dimensionCoverage,
    requirementDetails,
    duplicateCandidates,
    tests: suiteReviewTests,
    valueScoreDistribution: distributionOf(
      suiteReviewTests.map((t) => t.valueScore.total),
      // Value scores are banded (Section 8.4) -- reuse the model's own band names/edges directly
      // rather than inventing a second, parallel bucketing scheme.
      valueModel.valueBands.map((b) => ({ label: b.band, min: b.minScore, max: b.maxScore })),
    ),
    qualityScoreDistribution: distributionOf(
      suiteReviewTests.map((t) => t.qualityScore.total),
      QUALITY_BAND_EDGES,
    ),
    reviewQueue,
    changesFromPreviousReview,
  };

  // --- 8: validate against the schema ------------------------------------------------------------
  const validated = SuiteReviewSchema.safeParse(review);
  if (!validated.success) {
    console.error(
      `Suite review FAILED its own schema validation -- this is a bug in suite-review.ts, not ` +
        `something to silently coerce past:\n` +
        validated.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
    process.exit(1);
  }

  // --- 9: write JSON + HTML ------------------------------------------------------------------------
  mkdirSync(SUITE_REVIEWS_DIR, { recursive: true });
  const jsonPath = resolve(SUITE_REVIEWS_DIR, `${reviewId}.json`);
  writeFileSync(jsonPath, JSON.stringify(validated.data, null, 2) + "\n", "utf-8");

  const htmlPath = resolve(SUITE_REVIEWS_DIR, `${reviewId}.html`);
  try {
    writeFileSync(htmlPath, renderSuiteReviewHtml(validated.data), "utf-8");
  } catch (err) {
    console.error(
      `\nSuite-review HTML generation failed (the JSON at ${relative(ROOT, jsonPath)} was still written):\n${err instanceof Error ? err.stack : err}`,
    );
  }

  console.log(`Suite review ${reviewId} written:`);
  console.log(`  JSON: ${relative(ROOT, jsonPath)}`);
  if (existsSync(htmlPath)) console.log(`  HTML: ${relative(ROOT, htmlPath)}`);
  console.log(
    `\n${discovered.length} test(s) reviewed. Requirement coverage: ${requirementCoverageBucket.covered}/${requirementCoverageBucket.total}. Review queue: ${reviewQueue.length} item(s).`,
  );
}

main();
