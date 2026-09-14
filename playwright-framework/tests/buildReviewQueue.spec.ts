import { test, expect } from "@playwright/test";
import { buildReviewQueue } from "../coverage/buildReviewQueue.js";
import type { SuiteReviewTestEntry, RequirementCoverageEntry, DuplicateCandidate, ScoreResultShape } from "../metadata/schemas.js";

function score(total: number, overrides: Partial<ScoreResultShape> = {}): ScoreResultShape {
  return {
    modelVersion: "1.0.0",
    total,
    source: "calculated",
    criteria: [],
    provisional: false,
    ...overrides,
  };
}

function entry(overrides: Partial<SuiteReviewTestEntry> = {}): SuiteReviewTestEntry {
  return {
    testId: "t1",
    title: "t1",
    filePath: "e2e/tests/x.spec.ts",
    line: 1,
    tags: ["@readonly", "@feature:guests", "@risk:normal"],
    requirementIds: ["REQ-A"],
    objective: "does a thing",
    expectedOutcome: "the thing happens",
    valueScore: score(20),
    qualityScore: score(90),
    quarantined: false,
    recommendations: [],
    ...overrides,
  };
}

test.describe("buildReviewQueue", () => {
  test("a healthy, non-duplicate, high-quality, fully-hand-evaluated test with no coverage gap is excluded entirely", () => {
    const t = entry({
      lastKnownResult: {
        status: "initial-pass",
        runId: "r1",
        endedAt: "2026-01-01T00:00:00.000Z",
        ageDays: 1,
        staleBeyondFreshnessWindow: false,
        durationMs: 500,
      },
      qualityScore: score(90, {
        criteria: [
          {
            criterionId: "assertion-strength-and-objective-traceability",
            label: "x",
            weight: 20,
            points: 19,
            rationale: "x",
            confidence: "high",
            needsHumanReview: false,
          },
        ],
      }),
      valueScore: score(20, {
        criteria: [
          {
            criterionId: "security-compliance-data-integrity",
            label: "x",
            weight: 15,
            points: 5,
            rationale: "x",
            confidence: "high",
            needsHumanReview: false,
          },
        ],
      }),
    });
    const queue = buildReviewQueue({ tests: [t], requirementDetails: [], duplicateCandidates: [] });
    expect(queue).toEqual([]);
  });

  test("a never-executed test is queued with a clear reason", () => {
    const t = entry();
    const queue = buildReviewQueue({ tests: [t], requirementDetails: [], duplicateCandidates: [] });
    expect(queue).toHaveLength(1);
    expect(queue[0].testId).toBe("t1");
    expect(queue[0].reasons.some((r) => r.includes("never been executed"))).toBe(true);
  });

  test("a failing test outranks a merely stale test", () => {
    const failing = entry({
      testId: "failing-test",
      lastKnownResult: {
        status: "consistent-failure",
        runId: "r1",
        endedAt: "x",
        ageDays: 1,
        staleBeyondFreshnessWindow: false,
        durationMs: 500,
      },
    });
    const stale = entry({
      testId: "stale-test",
      lastKnownResult: {
        status: "initial-pass",
        runId: "r1",
        endedAt: "x",
        ageDays: 90,
        staleBeyondFreshnessWindow: true,
        durationMs: 500,
      },
    });
    const queue = buildReviewQueue({ tests: [failing, stale], requirementDetails: [], duplicateCandidates: [] });
    expect(queue.map((i) => i.testId)).toEqual(["failing-test", "stale-test"]);
  });

  test("covering the only test for an at-risk, unhealthy requirement is flagged", () => {
    const t = entry({ testId: "t1", tags: ["@readonly", "@risk:critical"], requirementIds: ["REQ-CRITICAL"] });
    const requirementDetails: RequirementCoverageEntry[] = [
      {
        requirementId: "REQ-CRITICAL",
        title: "Critical thing",
        status: "confirmed",
        coveringTestIds: ["t1"],
        coveredOnlyByUnhealthyTests: true,
      },
    ];
    const queue = buildReviewQueue({ tests: [t], requirementDetails, duplicateCandidates: [] });
    expect(queue[0].reasons.some((r) => r.includes("REQ-CRITICAL"))).toBe(true);
  });

  test("a requirement covered only by unhealthy tests but at @risk:low is NOT flagged (not high/critical risk)", () => {
    const t = entry({ testId: "t1", tags: ["@readonly", "@risk:low"], requirementIds: ["REQ-LOW"] });
    const requirementDetails: RequirementCoverageEntry[] = [
      {
        requirementId: "REQ-LOW",
        title: "Low-risk thing",
        status: "confirmed",
        coveringTestIds: ["t1"],
        coveredOnlyByUnhealthyTests: true,
      },
    ];
    // No health signal on t1 itself either (never-executed will still queue it, but not for the
    // at-risk-requirement reason specifically).
    const t2 = entry({
      testId: "t1",
      tags: ["@readonly", "@risk:low"],
      requirementIds: ["REQ-LOW"],
      lastKnownResult: {
        status: "initial-pass",
        runId: "r",
        endedAt: "x",
        ageDays: 1,
        staleBeyondFreshnessWindow: false,
        durationMs: 100,
      },
    });
    const queue = buildReviewQueue({ tests: [t2], requirementDetails, duplicateCandidates: [] });
    expect(queue).toEqual([]);
  });

  test("a duplicate-candidate member is flagged, naming the other test(s)", () => {
    const a = entry({ testId: "a" });
    const b = entry({ testId: "b" });
    const duplicateCandidates: DuplicateCandidate[] = [
      {
        testIds: ["a", "b"],
        sharedRequirementIds: ["REQ-A"],
        sharedTags: ["@readonly"],
        objectiveSimilarity: 0.9,
        rationale: "near-identical objectives",
      },
    ];
    const queue = buildReviewQueue({ tests: [a, b], requirementDetails: [], duplicateCandidates });
    expect(queue).toHaveLength(2);
    const aItem = queue.find((i) => i.testId === "a")!;
    expect(aItem.reasons.some((r) => r.includes("b"))).toBe(true);
  });

  test("a high-value test with poor quality earns the combined bonus, ranking above poor quality alone", () => {
    const poorQualityOnly = entry({
      testId: "poor-quality-only",
      valueScore: score(20),
      qualityScore: score(40),
    });
    const highValuePoorQuality = entry({
      testId: "high-value-poor-quality",
      valueScore: score(75),
      qualityScore: score(40),
    });
    const queue = buildReviewQueue({
      tests: [poorQualityOnly, highValuePoorQuality],
      requirementDetails: [],
      duplicateCandidates: [],
    });
    expect(queue.map((i) => i.testId)).toEqual(["high-value-poor-quality", "poor-quality-only"]);
  });

  test("missing hand-authored evaluation criteria (needsHumanReview) is a queued reason", () => {
    const t = entry({
      qualityScore: score(70, {
        criteria: [
          {
            criterionId: "assertion-strength-and-objective-traceability",
            label: "x",
            weight: 20,
            points: 0,
            rationale: "no entry",
            confidence: "low",
            needsHumanReview: true,
          },
        ],
      }),
    });
    const queue = buildReviewQueue({ tests: [t], requirementDetails: [], duplicateCandidates: [] });
    expect(queue[0].reasons.some((r) => r.includes("test-evaluations.yaml"))).toBe(true);
  });

  test("disproportionate execution time flags a slow, low-value test relative to the suite average", () => {
    const fastResult = (testId: string) =>
      entry({
        testId,
        valueScore: score(50),
        lastKnownResult: {
          status: "initial-pass",
          runId: "r",
          endedAt: "x",
          ageDays: 1,
          staleBeyondFreshnessWindow: false,
          durationMs: 100,
        },
      });
    // Several fast tests keep the suite average low, so one slow outlier clears the 2x threshold.
    const fastTests = ["fast-1", "fast-2", "fast-3"].map(fastResult);
    const slowLowValue = entry({
      testId: "slow-low-value",
      valueScore: score(10),
      lastKnownResult: {
        status: "initial-pass",
        runId: "r",
        endedAt: "x",
        ageDays: 1,
        staleBeyondFreshnessWindow: false,
        durationMs: 10000,
      },
    });
    const queue = buildReviewQueue({
      tests: [...fastTests, slowLowValue],
      requirementDetails: [],
      duplicateCandidates: [],
    });
    const slowItem = queue.find((i) => i.testId === "slow-low-value")!;
    expect(slowItem.reasons.some((r) => r.includes("disproportionate execution time"))).toBe(true);
  });

  test("results are sorted by descending priority, ties broken by testId", () => {
    const a = entry({ testId: "b-test" });
    const b = entry({ testId: "a-test" });
    const queue = buildReviewQueue({ tests: [a, b], requirementDetails: [], duplicateCandidates: [] });
    // Both never-executed -> equal priority -> alphabetical tie-break.
    expect(queue.map((i) => i.testId)).toEqual(["a-test", "b-test"]);
  });
});
