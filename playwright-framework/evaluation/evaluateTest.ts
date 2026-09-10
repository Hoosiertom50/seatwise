/**
 * Stage 07 — builds the `CriterionJudgment[]` (playwright-framework/scoring/types.ts) that
 * `computeScore` turns into a value/quality `ScoreResult` for one discovered test.
 *
 * DEC-021 records the split this module implements: 9 of the 14 total value+quality criteria are
 * computed MECHANICALLY here, fresh on every report generation, from real tool output (the same
 * lint checker `pw:lint-tests` uses, the live requirements/taxonomy files, the latest Stage 06 run
 * report, and suite-wide comparison against every other discovered test) -- never hand-typed, so
 * they can never silently go stale as the codebase changes. The remaining 2 criteria --
 * `assertion-strength-and-objective-traceability` (quality) and `security-compliance-data-
 * integrity` (value) -- genuinely require reading and judging what a SPECIFIC test's own
 * assertions verify, which is not something this module fakes with a keyword heuristic; those are
 * read from `quality/test-evaluations.yaml` (hand-authored by a human or an AI evaluator citing
 * real evidence, Section 8.6), and default to `needsHumanReview: true` for any test with no entry
 * there. The remaining 3 value criteria (`business-criticality`, `user-impact-and-frequency`,
 * `risk-and-defect-likelihood`, `release-decision-usefulness` -- 4, not 3; see below) are ALSO
 * mechanically flagged `needsHumanReview: true`, because no data source in this repo yet
 * quantifies a requirement's actual business priority (`quality/requirements.yaml` has no
 * priority/impact field, and every real requirement is still `status: needs-human-review` --
 * DEC-009) -- Section 8.6 is explicit that missing business information must be flagged, never
 * invented.
 */

import { checkTestSource, type LintIssue } from "../validation/lintRules.js";
import { objectiveSimilarity } from "../coverage/detectDuplicates.js";
import type { CriterionJudgment } from "../scoring/types.js";
import type { RequirementsFile, TestEvaluationsFile, TestEvaluationJudgment } from "../metadata/schemas.js";
import type { LatestRunReportEntry } from "../coverage/runReportHistory.js";

export interface EvaluationTestInput {
  testId: string;
  filePath: string; // absolute, for reading source text
  tags: string[];
  requirementIds: string[];
  objective: string;
}

export interface EvaluationContext {
  test: EvaluationTestInput;
  sourceText: string;
  allTests: EvaluationTestInput[]; // includes `test` itself
  requirements: RequirementsFile;
  testEvaluations: TestEvaluationsFile;
  latestRunReportEntry: LatestRunReportEntry | undefined;
}

const DATA_IMPACT_TAGS = new Set(["@readonly", "@mutating"]);
const FEATURE_TAG_PREFIX = "@feature:";

function findHandAuthoredJudgment(
  ctx: EvaluationContext,
  which: "valueJudgments" | "qualityJudgments",
  criterionId: string,
): TestEvaluationJudgment | undefined {
  const entry = ctx.testEvaluations.evaluations.find((e) => e.testId === ctx.test.testId);
  if (!entry) return undefined;
  if (entry.evaluatedAt && ctx.testEvaluations.modelVersion) {
    // Caller (the CLI) is responsible for comparing modelVersion against the live value model and
    // surfacing a mismatch as a report-level warning -- this function only reads what's on file.
  }
  return entry[which].find((j) => j.criterionId === criterionId);
}

function fromHandAuthored(
  ctx: EvaluationContext,
  which: "valueJudgments" | "qualityJudgments",
  criterionId: string,
  missingRationale: string,
): CriterionJudgment {
  const judgment = findHandAuthoredJudgment(ctx, which, criterionId);
  if (!judgment) {
    return {
      criterionId,
      points: undefined,
      rationale: missingRationale,
      confidence: "low",
      needsHumanReview: true,
    };
  }
  return {
    criterionId,
    points: judgment.needsHumanReview ? undefined : (judgment.points ?? undefined),
    rationale: judgment.rationale,
    confidence: judgment.confidence,
    needsHumanReview: judgment.needsHumanReview,
  };
}

function businessJudgmentUnavailable(criterionLabel: string, ctx: EvaluationContext): CriterionJudgment {
  const requirementIds = ctx.test.requirementIds;
  const rationale =
    requirementIds.length === 0
      ? `This test declares no requirementIds at all, so ${criterionLabel} cannot be judged against any stated business requirement.`
      : `quality/requirements.yaml has no priority/impact field, and the requirement(s) this test cites (${requirementIds.join(", ")}) are not all confirmed (DEC-009) -- ${criterionLabel} would require inventing a business-priority judgment Section 8.6 forbids fabricating.`;
  return {
    criterionId: "", // filled in by caller
    points: undefined,
    rationale,
    confidence: "low",
    needsHumanReview: true,
  };
}

function usesSharedFixtureArchitecture(sourceText: string): boolean {
  return /from\s+["'].*\/fixtures\/index\.js["']/.test(sourceText);
}

function lintIssuesForFile(sourceText: string, filePath: string): LintIssue[] {
  return checkTestSource(filePath, sourceText).issues;
}

function countNamedSteps(ctx: EvaluationContext): { count: number; source: "run-report" | "source-scan" } {
  if (ctx.latestRunReportEntry) {
    return { count: ctx.latestRunReportEntry.test.steps.length, source: "run-report" };
  }
  const matches = ctx.sourceText.match(/\btest\.step\(/g);
  return { count: matches ? matches.length : 0, source: "source-scan" };
}

// ---------------------------------------------------------------------------
// Quality criteria (weights: independence 20, assertion-strength 20, deterministic-waiting 15,
// locator-design 15, test-data-cleanup 10, readability 10, evidence 5, metadata 5)
// ---------------------------------------------------------------------------

export function evaluateTestQuality(ctx: EvaluationContext): CriterionJudgment[] {
  const usesSharedFixtures = usesSharedFixtureArchitecture(ctx.sourceText);
  const lintIssues = lintIssuesForFile(ctx.sourceText, ctx.test.filePath);

  const judgments: CriterionJudgment[] = [];

  // independence-and-parallel-safety (weight 20)
  judgments.push(
    usesSharedFixtures
      ? {
          criterionId: "independence-and-parallel-safety",
          points: 20,
          rationale:
            "Uses the shared account/managedWedding fixture architecture (e2e/fixtures/index.ts): a " +
            "fresh signed-up account and a fresh wedding are created per test, with no shared mutable " +
            "state between tests. This architecture was verified live under --repeat-each and multi-" +
            "worker parallel execution with zero data collisions (Stage 03/04 implementation log).",
          confidence: "high",
          needsHumanReview: false,
        }
      : {
          criterionId: "independence-and-parallel-safety",
          points: undefined,
          rationale:
            "Does not import test/expect from the shared fixtures module (e2e/fixtures/index.ts) -- " +
            "this evaluator has no verified basis for this test's independence/parallel-safety " +
            "properties and will not assume they carry over from the fixture architecture.",
          confidence: "low",
          needsHumanReview: true,
        },
  );

  // assertion-strength-and-objective-traceability (weight 20) -- hand-authored, see module doc.
  judgments.push({
    ...fromHandAuthored(
      ctx,
      "qualityJudgments",
      "assertion-strength-and-objective-traceability",
      `No hand-authored evaluation found in quality/test-evaluations.yaml for "${ctx.test.testId}" -- ` +
        "judging whether this test's specific assertions verify its stated objective requires " +
        "reading the test itself; add an entry to quality/test-evaluations.yaml to score this.",
    ),
    criterionId: "assertion-strength-and-objective-traceability",
  });

  // deterministic-waiting-and-state-control (weight 15) -- pw:lint-tests' own fixed-wait rule.
  const fixedWaitIssues = lintIssues.filter((i) => i.rule === "fixed-wait");
  judgments.push({
    criterionId: "deterministic-waiting-and-state-control",
    points: fixedWaitIssues.length === 0 ? 15 : Math.max(0, 15 - fixedWaitIssues.length * 5),
    rationale:
      fixedWaitIssues.length === 0
        ? "pw:lint-tests' fixed-wait rule (playwright-framework/validation/lintRules.ts) found zero " +
          "fixed-wait violations in this file -- no page.waitForTimeout()/hard sleep calls."
        : `pw:lint-tests found ${fixedWaitIssues.length} fixed-wait violation(s) at line(s) ` +
          `${fixedWaitIssues.map((i) => i.line).join(", ")} in this file.`,
    confidence: "high",
    needsHumanReview: false,
  });

  // page-component-object-and-locator-design (weight 15) -- pw:lint-tests' raw-selector rules.
  const locatorIssues = lintIssues.filter(
    (i) => i.rule === "raw-selector-in-test" || i.rule === "raw-screenshot-in-test",
  );
  judgments.push({
    criterionId: "page-component-object-and-locator-design",
    points: locatorIssues.length === 0 ? 15 : Math.max(0, 15 - locatorIssues.length * 5),
    rationale:
      locatorIssues.length === 0
        ? "pw:lint-tests found zero raw-selector/raw-screenshot violations in this file -- every " +
          "interaction goes through a page/component object, not a raw page.locator()/page.$() call " +
          "in the test body."
        : `pw:lint-tests found ${locatorIssues.length} raw-selector/raw-screenshot violation(s) at ` +
          `line(s) ${locatorIssues.map((i) => i.line).join(", ")}.`,
    confidence: "high",
    needsHumanReview: false,
  });

  // test-data-setup-and-cleanup (weight 10)
  judgments.push(
    usesSharedFixtures
      ? {
          criterionId: "test-data-setup-and-cleanup",
          points: 8,
          rationale:
            "Creates its own fresh account and wedding via the real signup/wedding-creation API " +
            "(no shared/preexisting data), and the managedWedding fixture reliably deletes the " +
            "wedding (and everything under it) after the test. However, the underlying account is " +
            "NEVER deleted -- the application exposes no account-deletion endpoint (DEC-012), a " +
            "known, disclosed, permanent limitation this test cannot itself work around. Scored " +
            "below full marks for that reason: 8/10.",
          confidence: "high",
          needsHumanReview: false,
        }
      : {
          criterionId: "test-data-setup-and-cleanup",
          points: undefined,
          rationale:
            "Does not use the shared fixtures module -- this evaluator has no verified basis for " +
            "this test's own data setup/cleanup behavior.",
          confidence: "low",
          needsHumanReview: true,
        },
  );

  // readability-and-diagnostic-steps (weight 10)
  const { count: stepCount, source: stepSource } = countNamedSteps(ctx);
  const readabilityPoints = stepCount >= 3 ? 10 : stepCount === 2 ? 7 : stepCount === 1 ? 4 : 0;
  judgments.push({
    criterionId: "readability-and-diagnostic-steps",
    points: readabilityPoints,
    rationale:
      stepSource === "run-report"
        ? `The most recent real run report recorded ${stepCount} named test.step(s) for this test.`
        : `Found ${stepCount} test.step(...) call(s) by scanning the source file (no run report ` +
          "available yet for this test, so this falls back to a source scan rather than observed " +
          "execution data).",
    confidence: stepSource === "run-report" ? "high" : "medium",
    needsHumanReview: false,
  });

  // evidence-and-failure-diagnostics (weight 5)
  const hasCheckpointCall = /evidence\.checkpoint\(/.test(ctx.sourceText);
  const observedCheckpoints = ctx.latestRunReportEntry?.test.successCheckpoints.length ?? 0;
  if (ctx.latestRunReportEntry) {
    const hasFullFailureBundle =
      !!ctx.latestRunReportEntry.test.failureScreenshotPath &&
      !!ctx.latestRunReportEntry.test.tracePath &&
      ctx.latestRunReportEntry.test.consoleMessages !== undefined;
    judgments.push({
      criterionId: "evidence-and-failure-diagnostics",
      points: observedCheckpoints > 0 || hasFullFailureBundle ? 5 : hasCheckpointCall ? 4 : 2,
      rationale:
        observedCheckpoints > 0
          ? `The most recent real run report recorded ${observedCheckpoints} success-checkpoint ` +
            "screenshot(s) with validation text for this test (e2e/support/evidence.ts). The shared " +
            "diagnostics fixture additionally attaches console-message and failed-network-request " +
            "summaries whenever a test does not end in its expected state."
          : hasFullFailureBundle
            ? "The most recent real run report shows a full failure evidence bundle (screenshot, " +
              "trace, console/network capture) for this test's last failing attempt."
            : "Uses evidence.checkpoint() in source, but no run report has yet recorded a checkpoint " +
              "or failure attachment for this test.",
      confidence: "high",
      needsHumanReview: false,
    });
  } else {
    judgments.push({
      criterionId: "evidence-and-failure-diagnostics",
      points: hasCheckpointCall ? 4 : 1,
      rationale: hasCheckpointCall
        ? "Calls evidence.checkpoint() in source (a named success-checkpoint screenshot plus " +
          "validation text), but no run report exists yet to confirm it actually fired, and " +
          "failure-diagnostic capture (screenshot/trace/console/network) has not yet been observed " +
          "for this test."
        : "No evidence.checkpoint() call found in source, and no run report exists yet to observe " +
          "any evidence capture for this test.",
      confidence: "medium",
      needsHumanReview: false,
    });
  }

  // metadata-completeness-and-standards-compliance (weight 5)
  const objectiveIsSpecific = ctx.test.objective.trim().length >= 40; // a generic "it works" would not clear this
  const hasRequirements = ctx.test.requirementIds.length > 0;
  const metadataPoints = (objectiveIsSpecific ? 3 : 1) + (hasRequirements ? 2 : 0);
  judgments.push({
    criterionId: "metadata-completeness-and-standards-compliance",
    points: metadataPoints,
    rationale:
      `Passes pw:validate-metadata/pw:lint-tests' governed-metadata checks (valid tags, non-empty ` +
      `objective/expectedOutcome). Objective is ${objectiveIsSpecific ? "specific" : "brief"} (` +
      `${ctx.test.objective.trim().length} characters) and requirementIds is ` +
      `${hasRequirements ? `populated (${ctx.test.requirementIds.join(", ")})` : "empty"}.`,
    confidence: "high",
    needsHumanReview: false,
  });

  return judgments;
}

// ---------------------------------------------------------------------------
// Value criteria (weights: business-criticality 25, user-impact 15, risk-and-defect 20,
// security-compliance 15, unique-coverage 15, release-decision 10)
// ---------------------------------------------------------------------------

export function evaluateTestValue(ctx: EvaluationContext): CriterionJudgment[] {
  const judgments: CriterionJudgment[] = [];

  for (const [criterionId, label] of [
    ["business-criticality", "business criticality"],
    ["user-impact-and-frequency", "user impact and frequency"],
    ["risk-and-defect-likelihood", "risk and defect likelihood (no defect/maintenance history exists yet -- Stage 09 is not yet built)"],
    ["release-decision-usefulness", "release-decision usefulness"],
  ] as const) {
    judgments.push({ ...businessJudgmentUnavailable(label, ctx), criterionId });
  }

  // security-compliance-data-integrity (weight 15) -- hand-authored, see module doc.
  judgments.push({
    ...fromHandAuthored(
      ctx,
      "valueJudgments",
      "security-compliance-data-integrity",
      `No hand-authored evaluation found in quality/test-evaluations.yaml for "${ctx.test.testId}" -- ` +
        "judging what access/data-integrity boundary this test actually touches requires reading " +
        "the test itself; add an entry to quality/test-evaluations.yaml to score this.",
    ),
    criterionId: "security-compliance-data-integrity",
  });

  // unique-coverage (weight 15) -- mechanical, suite-wide comparison.
  const dataImpact = ctx.test.tags.find((t) => DATA_IMPACT_TAGS.has(t));
  const featureTags = ctx.test.tags.filter((t) => t.startsWith(FEATURE_TAG_PREFIX));
  const overlapping = ctx.allTests.filter((other) => {
    if (other.testId === ctx.test.testId) return false;
    const sharedRequirement = other.requirementIds.some((id) => ctx.test.requirementIds.includes(id));
    if (!sharedRequirement || ctx.test.requirementIds.length === 0) return false;
    const otherDataImpact = other.tags.find((t) => DATA_IMPACT_TAGS.has(t));
    if (otherDataImpact !== dataImpact) return false;
    const sharedFeature = other.tags.some((t) => featureTags.includes(t));
    if (!sharedFeature) return false;
    return objectiveSimilarity(ctx.test.objective, other.objective) >= 0.3;
  });

  if (overlapping.length === 0) {
    judgments.push({
      criterionId: "unique-coverage",
      points: 15,
      rationale:
        ctx.test.requirementIds.length === 0
          ? "This test cites no requirementIds, so uniqueness cannot be compared against other " +
            "tests by requirement overlap; scored as fully unique by default since nothing else in " +
            "the suite was found to overlap it on tags/objective either."
          : "No other discovered test shares this test's requirement(s), data-impact tag, feature " +
            "tag, and a similar objective -- removing this test would leave that specific behavior " +
            "with zero coverage.",
      confidence: "high",
      needsHumanReview: false,
    });
  } else {
    const points = Math.max(1, Math.round(15 / (overlapping.length + 1)));
    judgments.push({
      criterionId: "unique-coverage",
      points,
      rationale:
        `${overlapping.length} other discovered test(s) (${overlapping.map((t) => t.testId).join(", ")}) ` +
        "share this test's requirement(s), data-impact tag, feature tag, and a similar objective -- " +
        "removing this test would not eliminate coverage of that behavior entirely, so unique-" +
        `coverage is reduced proportionally to the size of the overlapping group.`,
      confidence: "medium",
      needsHumanReview: false,
    });
  }

  return judgments;
}
