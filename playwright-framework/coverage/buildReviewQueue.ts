/**
 * Stage 07 — Section 10.3's "prioritized review queue for the human tester": a deterministic,
 * additive point-scoring pass over every discovered test that turns the suite-review's other
 * computed signals (coverage gaps, duplicate candidates, health, score totals) into a single
 * ranked list a human can work top-down, with each item's `reasons` spelling out exactly why it
 * is there (never a bare number with no explanation).
 *
 * Deliberately excludes a test entirely (rather than giving it priority 0) when none of the rules
 * below fire — "prioritized queue" means a worklist of what actually needs attention, not a
 * restatement of the full test roster. In particular, every value-score judgment currently being
 * `needsHumanReview` on the 4 forced-unresolvable business criteria (DEC-021) is NOT by itself a
 * reason a test appears here: with `quality/requirements.yaml` carrying no priority data yet, that
 * flag is true for the entire suite today, and surfacing it as a queue reason would swamp the
 * queue with noise rather than signal. Only the two GENUINELY resolvable hand-authored criteria
 * (assertion-strength, security-compliance) missing an entry counts as an actionable reason.
 */

import type {
  SuiteReviewTestEntry,
  RequirementCoverageEntry,
  DuplicateCandidate,
  ReviewQueueItemShape,
} from "../metadata/schemas.js";

export type ReviewQueueItem = ReviewQueueItemShape;

const RISK_TAGS_HIGH_PRIORITY = new Set(["@risk:critical", "@risk:high"]);
const FAILING_STATUSES = new Set(["consistent-failure", "timeout", "setup-failure", "skipped"]);

// Point values are additive and documented at each call site below -- there is no hidden formula;
// a reviewer can read this file top to bottom and reconstruct any item's total from its reasons.
const POINTS = {
  NEVER_EXECUTED: 35,
  FAILING: 30,
  COVERS_AT_RISK_UNHEALTHY_REQUIREMENT: 40,
  STALE: 20,
  QUARANTINED: 15,
  DUPLICATE_CANDIDATE: 25,
  LOW_QUALITY: 20,
  HIGH_VALUE_POOR_QUALITY_BONUS: 30,
  MISSING_HAND_AUTHORED_EVALUATION: 10,
  DISPROPORTIONATE_EXECUTION_TIME: 15,
} as const;

const LOW_QUALITY_THRESHOLD = 60; // out of 100
const HIGH_VALUE_THRESHOLD = 70; // out of 100
const LOW_VALUE_THRESHOLD = 40; // out of 100
const DISPROPORTIONATE_DURATION_MULTIPLE = 2; // "more than 2x the suite's own average duration"

export interface BuildReviewQueueInput {
  tests: SuiteReviewTestEntry[];
  requirementDetails: RequirementCoverageEntry[];
  duplicateCandidates: DuplicateCandidate[];
}

/** For each requirement covered ONLY by unhealthy tests, find the highest-priority @risk tag among
 * its covering tests -- a requirement is worth flagging on the queue only if the risk of leaving it
 * effectively untested (given today's evidence) is itself high or critical. */
function requirementIdsAtRiskAndUnhealthy(
  requirementDetails: RequirementCoverageEntry[],
  testsById: Map<string, SuiteReviewTestEntry>,
): Map<string, string[]> {
  // testId -> requirementId(s) it covers that are at-risk-and-unhealthy
  const result = new Map<string, string[]>();
  for (const req of requirementDetails) {
    if (!req.coveredOnlyByUnhealthyTests) continue;
    const isHighRisk = req.coveringTestIds.some((id) => {
      const test = testsById.get(id);
      return test?.tags.some((t) => RISK_TAGS_HIGH_PRIORITY.has(t));
    });
    if (!isHighRisk) continue;
    for (const testId of req.coveringTestIds) {
      const existing = result.get(testId) ?? [];
      existing.push(req.requirementId);
      result.set(testId, existing);
    }
  }
  return result;
}

function duplicateTestIds(duplicateCandidates: DuplicateCandidate[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const candidate of duplicateCandidates) {
    for (const testId of candidate.testIds) {
      const others = candidate.testIds.filter((id) => id !== testId);
      const existing = result.get(testId) ?? [];
      existing.push(...others);
      result.set(testId, existing);
    }
  }
  return result;
}

function averageDurationMs(tests: SuiteReviewTestEntry[]): number | undefined {
  const durations = tests
    .map((t) => t.lastKnownResult?.durationMs)
    .filter((d): d is number => d !== undefined);
  if (durations.length === 0) return undefined;
  return durations.reduce((sum, d) => sum + d, 0) / durations.length;
}

function hasMissingHandAuthoredEvaluation(test: SuiteReviewTestEntry): boolean {
  const assertionStrength = test.qualityScore.criteria.find(
    (c) => c.criterionId === "assertion-strength-and-objective-traceability",
  );
  const securityCompliance = test.valueScore.criteria.find(
    (c) => c.criterionId === "security-compliance-data-integrity",
  );
  return Boolean(assertionStrength?.needsHumanReview) || Boolean(securityCompliance?.needsHumanReview);
}

export function buildReviewQueue(input: BuildReviewQueueInput): ReviewQueueItem[] {
  const { tests, requirementDetails, duplicateCandidates } = input;
  const testsById = new Map(tests.map((t) => [t.testId, t]));
  const atRiskUnhealthy = requirementIdsAtRiskAndUnhealthy(requirementDetails, testsById);
  const duplicatesOf = duplicateTestIds(duplicateCandidates);
  const avgDuration = averageDurationMs(tests);

  const items: ReviewQueueItem[] = [];

  for (const test of tests) {
    let priority = 0;
    const reasons: string[] = [];

    if (!test.lastKnownResult) {
      priority += POINTS.NEVER_EXECUTED;
      reasons.push("has never been executed -- no run report has recorded a result for it yet.");
    } else {
      if (FAILING_STATUSES.has(test.lastKnownResult.status)) {
        priority += POINTS.FAILING;
        reasons.push(`last known result was "${test.lastKnownResult.status}".`);
      }
      if (test.lastKnownResult.staleBeyondFreshnessWindow) {
        priority += POINTS.STALE;
        reasons.push(
          `last executed ${test.lastKnownResult.ageDays.toFixed(1)} day(s) ago -- outside the configured freshness window.`,
        );
      }
    }

    if (test.quarantined) {
      priority += POINTS.QUARANTINED;
      reasons.push("is quarantined (@quarantined) and excluded from default runs.");
    }

    const atRiskReqIds = atRiskUnhealthy.get(test.testId);
    if (atRiskReqIds && atRiskReqIds.length > 0) {
      priority += POINTS.COVERS_AT_RISK_UNHEALTHY_REQUIREMENT;
      reasons.push(
        `is the only coverage for at-risk requirement(s) ${atRiskReqIds.join(", ")}, and is not currently healthy.`,
      );
    }

    const duplicateIds = duplicatesOf.get(test.testId);
    if (duplicateIds && duplicateIds.length > 0) {
      priority += POINTS.DUPLICATE_CANDIDATE;
      reasons.push(`flagged as a possible duplicate of ${duplicateIds.join(", ")} -- review before removing either.`);
    }

    const qualityLow = test.qualityScore.total < LOW_QUALITY_THRESHOLD;
    if (qualityLow) {
      priority += POINTS.LOW_QUALITY;
      reasons.push(`quality score is low (${test.qualityScore.total}/100).`);
      if (test.valueScore.total >= HIGH_VALUE_THRESHOLD) {
        priority += POINTS.HIGH_VALUE_POOR_QUALITY_BONUS;
        reasons.push(
          `carries a high value score (${test.valueScore.total}/100) alongside that poor quality -- ` +
            "this is exactly the combination Section 10.3 asks the report to surface.",
        );
      }
    }

    if (hasMissingHandAuthoredEvaluation(test)) {
      priority += POINTS.MISSING_HAND_AUTHORED_EVALUATION;
      reasons.push(
        "has no hand-authored entry in quality/test-evaluations.yaml for assertion-strength and/or " +
          "security-compliance -- those criteria cannot be judged mechanically.",
      );
    }

    if (
      avgDuration !== undefined &&
      test.lastKnownResult?.durationMs !== undefined &&
      test.lastKnownResult.durationMs > avgDuration * DISPROPORTIONATE_DURATION_MULTIPLE &&
      test.valueScore.total < LOW_VALUE_THRESHOLD
    ) {
      priority += POINTS.DISPROPORTIONATE_EXECUTION_TIME;
      reasons.push(
        `takes ${Math.round(test.lastKnownResult.durationMs)}ms, more than ${DISPROPORTIONATE_DURATION_MULTIPLE}x ` +
          `the suite's own average (${Math.round(avgDuration)}ms), while scoring a low value ` +
          `(${test.valueScore.total}/100) -- disproportionate execution time for what it covers.`,
      );
    }

    if (reasons.length > 0) {
      items.push({ testId: test.testId, priority, reasons });
    }
  }

  // Highest priority first; ties broken by testId for a stable, reproducible ordering across runs.
  items.sort((a, b) => b.priority - a.priority || a.testId.localeCompare(b.testId));
  return items;
}
