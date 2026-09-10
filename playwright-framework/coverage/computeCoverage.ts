/**
 * Stage 07 — pure coverage arithmetic (Section 10.3): requirement coverage, risk-weighted
 * coverage, and per-dimension tag coverage, plus the "covered only by unhealthy tests" and
 * freshness classifications those coverage numbers depend on. No I/O here -- callers (the
 * suite-review CLI, and this module's own unit tests) supply already-loaded requirements/tests/
 * taxonomy/execution-history data.
 *
 * DEC-022 records the risk-weighting rule this module implements: an uncovered requirement is
 * conservatively weighted as if it were @risk:critical, since its real risk is unconfirmed without
 * a test -- this guarantees risk-weighted coverage can never read HIGHER than plain requirement
 * coverage, which is the intuitively correct relationship (missing coverage should never look
 * better just because we don't yet know how risky the gap is).
 */

import type {
  RequirementsFile,
  TagTaxonomyFile,
  CoverageBucket,
  RequirementCoverageEntry,
  DimensionCoverageEntry,
} from "../metadata/schemas.js";
import type { LastKnownResult } from "./runReportHistory.js";

export interface CoverageTestInput {
  testId: string;
  tags: string[];
  requirementIds: string[];
}

const RISK_WEIGHTS: Record<string, number> = {
  "@risk:critical": 4,
  "@risk:high": 3,
  "@risk:normal": 2,
  "@risk:low": 1,
};
const UNCOVERED_RISK_WEIGHT = RISK_WEIGHTS["@risk:critical"]; // conservative assumption, see DEC-022

/** Requirement statuses counted in every coverage denominator here -- `placeholder` (explicitly
 * fake example entries, DEC-009) and `retired` requirements are excluded, disclosed via each
 * bucket's own `denominatorLabel`. */
const COVERAGE_ELIGIBLE_STATUSES = new Set(["needs-human-review", "confirmed"]);

export type TestHealth = "healthy" | "quarantined" | "never-executed" | "stale" | "failing";

export function classifyTestHealth(
  tags: string[],
  lastKnownResult: LastKnownResult | undefined,
  freshnessWindowDays: number,
): TestHealth {
  if (tags.includes("@quarantined")) return "quarantined";
  if (!lastKnownResult) return "never-executed";
  if (lastKnownResult.ageDays > freshnessWindowDays) return "stale";
  if (["consistent-failure", "timeout", "setup-failure", "skipped"].includes(lastKnownResult.status)) {
    return "failing";
  }
  return "healthy"; // initial-pass, retry-pass, expected-failure, quarantined(handled above)
}

export interface RequirementCoverageResult {
  bucket: CoverageBucket;
  details: RequirementCoverageEntry[];
}

export function computeRequirementCoverage(
  requirements: RequirementsFile,
  tests: CoverageTestInput[],
  health: Map<string, TestHealth>,
): RequirementCoverageResult {
  const eligible = requirements.requirements.filter((r) => COVERAGE_ELIGIBLE_STATUSES.has(r.status));
  const excludedCount = requirements.requirements.length - eligible.length;

  const details: RequirementCoverageEntry[] = eligible.map((req) => {
    const coveringTestIds = tests.filter((t) => t.requirementIds.includes(req.id)).map((t) => t.testId);
    const coveredOnlyByUnhealthyTests =
      coveringTestIds.length > 0 &&
      coveringTestIds.every((id) => (health.get(id) ?? "never-executed") !== "healthy");
    return {
      requirementId: req.id,
      title: req.title,
      status: req.status,
      coveringTestIds,
      coveredOnlyByUnhealthyTests,
    };
  });

  const covered = details.filter((d) => d.coveringTestIds.length > 0).length;

  return {
    bucket: {
      covered,
      total: eligible.length,
      denominatorLabel: `${eligible.length} requirement(s) with status "needs-human-review" or "confirmed" (${excludedCount} "placeholder"/"retired" requirement(s) excluded)`,
    },
    details,
  };
}

export interface RiskWeightedCoverageResult {
  bucket: CoverageBucket & { weightingRule: string };
}

export function computeRiskWeightedCoverage(
  requirementDetails: RequirementCoverageEntry[],
  tests: CoverageTestInput[],
): RiskWeightedCoverageResult {
  const testsById = new Map(tests.map((t) => [t.testId, t]));

  let coveredWeight = 0;
  let totalWeight = 0;
  for (const req of requirementDetails) {
    if (req.coveringTestIds.length === 0) {
      totalWeight += UNCOVERED_RISK_WEIGHT;
      continue;
    }
    const maxWeight = Math.max(
      ...req.coveringTestIds.map((id) => {
        const test = testsById.get(id);
        const riskTag = test?.tags.find((t) => t in RISK_WEIGHTS);
        return riskTag ? RISK_WEIGHTS[riskTag] : UNCOVERED_RISK_WEIGHT;
      }),
    );
    coveredWeight += maxWeight;
    totalWeight += maxWeight;
  }

  return {
    bucket: {
      covered: coveredWeight,
      total: totalWeight,
      denominatorLabel: `sum of risk weight (critical=4, high=3, normal=2, low=1) across the same ${requirementDetails.length} eligible requirement(s) as plain requirement coverage`,
      weightingRule:
        "each covered requirement is weighted by the HIGHEST @risk tier among its covering test(s); " +
        "an uncovered requirement is conservatively weighted as @risk:critical (4) since its real " +
        "risk is unconfirmed without a test -- this makes risk-weighted coverage a lower bound, " +
        "never inflated relative to plain requirement coverage",
    },
  };
}

export function computeDimensionCoverage(
  taxonomy: TagTaxonomyFile,
  tests: CoverageTestInput[],
): DimensionCoverageEntry[] {
  return taxonomy.dimensions.map((dimension) => {
    const countsByTag: Record<string, number> = {};
    for (const tagDef of dimension.tags) {
      countsByTag[tagDef.name] = tests.filter((t) => t.tags.includes(tagDef.name)).length;
    }
    return { dimension: dimension.name, countsByTag };
  });
}
