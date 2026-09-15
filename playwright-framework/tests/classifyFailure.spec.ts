// Stage 09 -- classifyFailure.ts, DEC-028's mechanical/hand-authored/insufficient-evidence tiers.
// Every fixture below is a plain, fully-typed RunReportTest/RunReport object (never parsed through
// the zod schema here -- these are unit tests of the classification LOGIC, not of schema
// validation, which schemas.spec.ts already covers separately).
import { test, expect } from "@playwright/test";
import { classifyFailure } from "../triage/classifyFailure.js";
import type { RunReportTest, RunReport, SuiteReview, FailureClassificationsFile } from "../metadata/schemas.js";
import type { RunReportHistory } from "../coverage/runReportHistory.js";

function baseTest(overrides: Partial<RunReportTest> = {}): RunReportTest {
  return {
    testId: "suite.some-test",
    title: "some test",
    filePath: "e2e/tests/suite.spec.ts",
    line: 10,
    tags: ["@readonly"],
    requirementIds: [],
    status: "consistent-failure",
    durationMs: 1000,
    attempts: 1,
    steps: [],
    assertionCount: 1,
    successCheckpoints: [],
    ...overrides,
  };
}

function baseReport(runId: string, tests: RunReportTest[], overrides: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: "1.0.0",
    runId,
    generatedAt: "2026-09-10T12:00:00.000Z",
    startedAt: "2026-09-10T11:59:00.000Z",
    endedAt: "2026-09-10T12:00:00.000Z",
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
    tagExpression: "",
    selectionSummary: { matchedCount: tests.length, excludedCount: 0 },
    counts: {
      initialPass: 0,
      retryPass: 0,
      consistentFailure: 0,
      timeout: 0,
      skipped: 0,
      expectedFailure: 0,
      quarantined: 0,
      setupFailure: 0,
    },
    tests,
    ...overrides,
  };
}

function history(reports: RunReport[]): RunReportHistory {
  return { reports, invalidFileCount: 0 };
}

const EMPTY_CLASSIFICATIONS: FailureClassificationsFile = { schemaVersion: "1.0.0", classifications: [] };

test.describe("mechanical tier: environment/infrastructure", () => {
  test("status setup-failure is classified environment-or-infrastructure-problem, high confidence, repair not allowed", () => {
    const failing = baseTest({ status: "setup-failure" });
    const report = baseReport("run-1", [failing]);
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([report]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.classification).toBe("environment-or-infrastructure-problem");
    expect(finding.confidence).toBe("high");
    expect(finding.repairAllowed).toBe(false);
    expect(finding.needsHumanReview).toBe(false);
    expect(finding.source).toBe("mechanical");
  });

  test("a known infra error-text pattern (ECONNREFUSED) is classified environment-or-infrastructure-problem even with status consistent-failure", () => {
    const failing = baseTest({ status: "consistent-failure", errorMessage: "Error: connect ECONNREFUSED 127.0.0.1:3000" });
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.classification).toBe("environment-or-infrastructure-problem");
    expect(finding.repairAllowed).toBe(false);
  });
});

test.describe("mechanical tier: intermittent/flaky (run history)", () => {
  test("a test that failed this run but passed in an earlier run is classified intermittent-flaky-behavior", () => {
    const failing = baseTest({ status: "consistent-failure" });
    const earlierPassing = baseTest({ status: "initial-pass" });
    const currentReport = baseReport("run-2", [failing]);
    const earlierReport = baseReport("run-1", [earlierPassing], { endedAt: "2026-09-09T12:00:00.000Z" });
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-2",
      runReportHistory: history([earlierReport, currentReport]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.classification).toBe("intermittent-flaky-behavior");
    expect(finding.needsHumanReview).toBe(true); // suggestive, not conclusive -- always flagged for review
    expect(finding.repairAllowed).toBe(true);
    expect(finding.repairAllowedFiles).toEqual([failing.filePath]);
  });

  test("a test with NO other run history at all is not classified as flaky just because it failed once", () => {
    const failing = baseTest({ status: "consistent-failure" });
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.classification).not.toBe("intermittent-flaky-behavior");
  });

  // Stage 09 AUDIT FINDING (High, fixed): a genuine, ongoing, deterministic application regression
  // used to be misclassified as "intermittent-flaky-behavior" (repairAllowed: true) merely because
  // the test happened to pass ONCE, arbitrarily long ago, in run-report history -- since
  // classifyFailure is only ever called on an already-failing test, the pre-fix condition
  // (`hasPassedElsewhere && (hasFailedElsewhere || FAILING_STATUSES.has(test.status))`) collapsed
  // to just `hasPassedElsewhere`, with no recency requirement at all. This directly undermined the
  // stage's own acceptance criterion ("A probable application bug remains visible and is not
  // 'fixed' by changing the test") by handing a real regression to the repair-eligible path instead
  // of insufficient-evidence/hand-authored review. The fix requires the MOST RECENT other run on
  // file to itself be a pass -- confirmed live to fail against the pre-fix code and pass after.
  test("a test that passed ONCE, long ago, then has failed deterministically in every run SINCE is NOT classified as flaky -- it is a real ongoing regression, not intermittent behavior", () => {
    const ancientPass = baseTest({ status: "initial-pass" });
    const recentFailures = [
      baseReport("run-1", [baseTest({ status: "consistent-failure" })], { endedAt: "2026-09-05T00:00:00.000Z" }),
      baseReport("run-2", [baseTest({ status: "consistent-failure" })], { endedAt: "2026-09-06T00:00:00.000Z" }),
      baseReport("run-3", [baseTest({ status: "consistent-failure" })], { endedAt: "2026-09-07T00:00:00.000Z" }),
      baseReport("run-4", [baseTest({ status: "consistent-failure" })], { endedAt: "2026-09-08T00:00:00.000Z" }),
    ];
    const ancientReport = baseReport("run-0-ancient", [ancientPass], { endedAt: "2026-03-01T00:00:00.000Z" });
    const currentFailure = baseTest({ status: "consistent-failure" });
    const currentReport = baseReport("run-5-current", [currentFailure], { endedAt: "2026-09-11T00:00:00.000Z" });

    const finding = classifyFailure({
      failingTest: currentFailure,
      runId: "run-5-current",
      runReportHistory: history([ancientReport, ...recentFailures, currentReport]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });

    expect(finding.classification).not.toBe("intermittent-flaky-behavior");
    expect(finding.classification).toBe("insufficient-evidence");
    expect(finding.repairAllowed).toBe(false);
  });

  // Companion positive case: genuine oscillation (the run immediately preceding this one actually
  // passed) is still correctly classified as flaky after the fix -- the fix narrows the signal, it
  // does not remove it.
  test("a test whose MOST RECENT other run passed, and is now failing, is still correctly classified as flaky after the recency fix", () => {
    const recentPass = baseTest({ status: "initial-pass" });
    const olderFailure = baseTest({ status: "consistent-failure" });
    const currentFailure = baseTest({ status: "consistent-failure" });
    const reports = [
      baseReport("run-1-older-fail", [olderFailure], { endedAt: "2026-09-01T00:00:00.000Z" }),
      baseReport("run-2-recent-pass", [recentPass], { endedAt: "2026-09-08T00:00:00.000Z" }),
      baseReport("run-3-current", [currentFailure], { endedAt: "2026-09-11T00:00:00.000Z" }),
    ];
    const finding = classifyFailure({
      failingTest: currentFailure,
      runId: "run-3-current",
      runReportHistory: history(reports),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.classification).toBe("intermittent-flaky-behavior");
    expect(finding.repairAllowed).toBe(true);
  });
});

test.describe("hand-authored tier", () => {
  test("a matching quality/failure-classifications.yaml entry (no errorFingerprint) is used directly, including a forced-safe repairAllowed clamp", () => {
    const failing = baseTest({ testId: "suite.known-flaky", status: "consistent-failure" });
    const classifications: FailureClassificationsFile = {
      schemaVersion: "1.0.0",
      classifications: [
        {
          testId: "suite.known-flaky",
          evaluatedAt: "2026-09-10",
          evaluatedBy: "AI (Claude, Stage 09 test fixture)",
          classification: "probable-application-defect",
          confidence: "high",
          needsHumanReview: false,
          rationale: "A human confirmed this is a real regression.",
          evidenceForApplicationDefect: ["reproduced manually against the live app"],
          evidenceAgainstApplicationDefect: [],
          evidenceForTestDefect: [],
          evidenceAgainstTestDefect: [],
          recommendedNextAction: "File a defect; do not repair the test.",
          // Deliberately set true here to confirm classifyFailure.ts clamps it back to false --
          // the schema-level .refine() on MaintenanceFindingSchema requires this invariant, and
          // this module is the one place responsible for upholding it before validation ever runs.
          repairAllowed: true,
          repairAllowedFiles: ["e2e/tests/suite.spec.ts"],
          suggestedDefectDescription: "Guest RSVP status renders stale after a concurrent update.",
        },
      ],
    };
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: classifications,
    });
    expect(finding.classification).toBe("probable-application-defect");
    expect(finding.source).toBe("hand-authored");
    expect(finding.repairAllowed).toBe(false); // clamped, despite the override file saying true
    expect(finding.needsHumanReview).toBe(true); // TS-58: clamped, despite the override file saying false
    expect(finding.suggestedDefectDescription).toBe("Guest RSVP status renders stale after a concurrent update.");
  });

  test("TS-58: needsHumanReview is clamped true for insufficient-evidence too, the same way repairAllowed already is", () => {
    // Same adversarial shape as the probable-application-defect case above, for the other
    // forced-no-repair category -- confirms the clamp in classifyFailure.ts's hand-authored tier
    // covers both members of `forcedNoRepair`, not just the first one a test happens to exercise.
    const failing = baseTest({ testId: "suite.unclear-cause", status: "consistent-failure" });
    const classifications: FailureClassificationsFile = {
      schemaVersion: "1.0.0",
      classifications: [
        {
          testId: "suite.unclear-cause",
          evaluatedAt: "2026-09-15",
          evaluatedBy: "AI (Claude, TS-58 test fixture)",
          classification: "insufficient-evidence",
          confidence: "low",
          // Deliberately set false here to confirm classifyFailure.ts clamps it back to true --
          // before TS-58's fix this was passed straight through, letting an insufficient-evidence
          // finding (which could hide a real application defect) render as "no further review
          // flagged" in the maintenance report.
          needsHumanReview: false,
          rationale: "Root cause not yet determined by a human.",
          evidenceForApplicationDefect: [],
          evidenceAgainstApplicationDefect: [],
          evidenceForTestDefect: [],
          evidenceAgainstTestDefect: [],
          recommendedNextAction: "Investigate further before deciding whether this is a real defect.",
          repairAllowed: false,
          repairAllowedFiles: [],
        },
      ],
    };
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: classifications,
    });
    expect(finding.classification).toBe("insufficient-evidence");
    expect(finding.source).toBe("hand-authored");
    expect(finding.repairAllowed).toBe(false);
    expect(finding.needsHumanReview).toBe(true); // clamped, despite the override file saying false
  });

  test("errorFingerprint scoping: an entry only matches a failure whose errorMessage contains it", () => {
    const failingMatch = baseTest({ testId: "suite.multi-mode", errorMessage: "duplicate key value violates unique constraint" });
    const failingNoMatch = baseTest({ testId: "suite.multi-mode", errorMessage: "some completely different error" });
    const classifications: FailureClassificationsFile = {
      schemaVersion: "1.0.0",
      classifications: [
        {
          testId: "suite.multi-mode",
          errorFingerprint: "duplicate key value violates unique constraint",
          evaluatedAt: "2026-09-10",
          evaluatedBy: "AI (Claude, Stage 09 test fixture)",
          classification: "test-data-problem",
          confidence: "high",
          needsHumanReview: false,
          rationale: "Known seed-data collision.",
          evidenceForApplicationDefect: [],
          evidenceAgainstApplicationDefect: [],
          evidenceForTestDefect: [],
          evidenceAgainstTestDefect: [],
          recommendedNextAction: "Adjust the test's own seed data to avoid the collision.",
          repairAllowed: true,
          repairAllowedFiles: [],
        },
      ],
    };
    const matched = classifyFailure({
      failingTest: failingMatch,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failingMatch])]),
      suiteReview: undefined,
      failureClassifications: classifications,
    });
    expect(matched.classification).toBe("test-data-problem");
    expect(matched.source).toBe("hand-authored");

    const unmatched = classifyFailure({
      failingTest: failingNoMatch,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failingNoMatch])]),
      suiteReview: undefined,
      failureClassifications: classifications,
    });
    expect(unmatched.classification).toBe("insufficient-evidence");
    expect(unmatched.source).toBe("insufficient-evidence-default");
  });
});

test.describe("default: insufficient evidence", () => {
  test("a failure matching no mechanical signal and no hand-authored entry defaults to insufficient-evidence, repair not allowed, needs human review", () => {
    const failing = baseTest({ testId: "suite.totally-unknown", errorMessage: "expect(received).toBe(expected): received PENDING, expected CONFIRMED" });
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.classification).toBe("insufficient-evidence");
    expect(finding.confidence).toBe("low");
    expect(finding.needsHumanReview).toBe(true);
    expect(finding.repairAllowed).toBe(false);
    expect(finding.source).toBe("insufficient-evidence-default");
  });
});

test.describe("evidence links and step/behavior fields", () => {
  test("evidence links include the test source, and failure attachments only when present", () => {
    const failing = baseTest({
      failureScreenshotPath: "artifacts/playwright/runs/test-results/x/failure.png",
      tracePath: "artifacts/playwright/runs/test-results/x/trace.zip",
    });
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    const paths = finding.evidenceLinks.map((l) => l.path);
    expect(paths).toContain(failing.filePath);
    expect(paths).toContain("artifacts/playwright/runs/test-results/x/failure.png");
    expect(paths).toContain("artifacts/playwright/runs/test-results/x/trace.zip");
    expect(paths).not.toContain(undefined);
  });

  test("firstFailedStep is the title of the first step with status failed, when steps were recorded", () => {
    const failing = baseTest({
      steps: [
        { title: "Sign up and create a wedding", category: "test.step", durationMs: 200, status: "passed" },
        { title: "Add a guest", category: "test.step", durationMs: 150, status: "failed", error: "locator not found" },
      ],
    });
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.firstFailedStep).toBe("Add a guest");
  });

  test("expected/observed behavior fall back sensibly when optional run-report fields are absent", () => {
    const failing = baseTest({ expectedOutcome: undefined, objective: undefined, whyFailed: undefined, errorMessage: undefined, status: "timeout", attempts: 2 });
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview: undefined,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.expectedBehavior).toContain("Not recorded");
    expect(finding.observedBehavior).toContain("timeout");
    expect(finding.observedBehavior).toContain("2 attempt");
  });
});

test.describe("sibling-test cross-reference (suite review)", () => {
  test("comparisonNotes mentions sibling test health when a suite review is available", () => {
    const failing = baseTest({ testId: "suite.a", requirementIds: ["REQ-1"] });
    const suiteReview: SuiteReview = {
      schemaVersion: "1.0.0",
      reviewId: "review-1",
      generatedAt: "2026-09-10T12:00:00.000Z",
      frameworkVersion: "0.9.0",
      gitCommit: "deadbeef",
      workingTreeClean: true,
      valueModelVersion: "1.0.0",
      freshnessWindowDays: 14,
      parseErrorCount: 0,
      requirementCoverage: { covered: 1, total: 1, denominatorLabel: "n/a" },
      riskWeightedCoverage: { covered: 1, total: 1, denominatorLabel: "n/a", weightingRule: "n/a" },
      dimensionCoverage: [],
      requirementDetails: [],
      duplicateCandidates: [],
      tests: [
        {
          testId: "suite.b",
          title: "sibling test",
          filePath: "e2e/tests/suite.spec.ts",
          line: 20,
          tags: [],
          requirementIds: ["REQ-1"],
          objective: "o",
          expectedOutcome: "e",
          valueScore: { modelVersion: "1.0.0", total: 50, band: "ok", source: "calculated", provisional: false, criteria: [] },
          qualityScore: { modelVersion: "1.0.0", total: 50, band: "ok", source: "calculated", provisional: false, criteria: [] },
          lastKnownResult: { status: "initial-pass", runId: "run-1", endedAt: "2026-09-10T12:00:00.000Z", ageDays: 0, staleBeyondFreshnessWindow: false, durationMs: 500 },
          quarantined: false,
          recommendations: [],
        },
      ],
      valueScoreDistribution: {},
      qualityScoreDistribution: {},
      reviewQueue: [],
    };
    const finding = classifyFailure({
      failingTest: failing,
      runId: "run-1",
      runReportHistory: history([baseReport("run-1", [failing])]),
      suiteReview,
      failureClassifications: EMPTY_CLASSIFICATIONS,
    });
    expect(finding.comparisonNotes).toContain("1/1 sibling test(s)");
    expect(finding.comparisonNotes).toContain("suite.b");
  });
});
