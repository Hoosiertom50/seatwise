/**
 * Stage 09 — mechanical-signal-first failure classification (Section 10.4). Given one real failing
 * test from a specific Stage 06 run report, decides which of the 7 required categories it belongs
 * to, and assembles every other field Section 10.4 requires per failure.
 *
 * DEC-028 records the tier split this module implements, deliberately mirroring DEC-021's
 * mechanical/hand-authored/forced-human-review discipline (Stage 07, evaluateTest.ts) rather than
 * inventing a new one:
 *
 *   - MECHANICAL tier (computed here, fresh, from real data on every run): only the two categories
 *     a structural signal can actually support without reading the failure's semantic content --
 *     "Environment or infrastructure problem" (the run report's own `status: "setup-failure"`, or a
 *     known infrastructure error-text pattern -- ECONNREFUSED, a browser launch failure, and
 *     similar) and "Intermittent/flaky behavior" (this exact test has BOTH passed and failed across
 *     different real run reports on file -- a structural fact about run history, not a guess).
 *   - The remaining four categories -- Probable application defect, Probable test defect, Intended
 *     application change, Test-data problem -- genuinely require judging what the failure's own
 *     error text and the test's intent actually mean, the same way DEC-021 draws the line for
 *     assertion-strength-and-objective-traceability and security-compliance-data-integrity. This
 *     module never guesses at those from a regex; it looks up `quality/failure-classifications.yaml`
 *     (hand-authored, per-test, optionally scoped to one distinct error text via
 *     `errorFingerprint`) for the HAND-AUTHORED tier.
 *   - A failure matching neither tier gets "Insufficient evidence", confidence "low",
 *     `needsHumanReview: true`, `repairAllowed: false` -- the same fail-closed default
 *     evaluateTest.ts uses for an unscored criterion, never a fabricated middle-ground guess.
 *
 * `repairAllowed` is computed here, once, as the single source of truth `/pw-repair-test`'s own
 * preflight and `repair-write-guard.mjs` both defer to (via the maintenance report this feeds):
 * mechanically `false` for "Probable application defect" and "Insufficient evidence" (Stage 09
 * acceptance criteria: a probable app bug is never "fixed" by editing the test, and no repair
 * proceeds on a failure nobody has actually explained), `false` for "Environment or infrastructure
 * problem" (not a test-code fix at all), and a `true` CANDIDATE for the remaining three categories
 * -- candidate only: the real write-time gate is still `repair-write-guard.mjs`'s two-layer scope
 * check plus a human's own explicit confirmation (`/pw-repair-test`'s preflight), never this module
 * alone.
 */

import type {
  MaintenanceFinding,
  FailureClassification,
  EvidenceLink,
  FailureClassificationsFile,
  SuiteReview,
  RunReportTest,
} from "../metadata/schemas.js";
import type { RunReportHistory } from "../coverage/runReportHistory.js";

const INFRA_ERROR_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ECONNREFUSED/i, label: "ECONNREFUSED (connection refused)" },
  { pattern: /ECONNRESET/i, label: "ECONNRESET (connection reset)" },
  { pattern: /EADDRINUSE/i, label: "EADDRINUSE (port already in use)" },
  { pattern: /getaddrinfo ENOTFOUND/i, label: "DNS resolution failure (ENOTFOUND)" },
  { pattern: /net::ERR_/i, label: "a browser-level net::ERR_* network failure" },
  { pattern: /browserType\.launch/i, label: "a browser launch failure" },
  { pattern: /Timed out waiting for (the )?server to start/i, label: "the app server failing to start in time" },
  { pattern: /socket hang up/i, label: "a socket hang-up" },
  { pattern: /Protocol error/i, label: "a browser/CDP protocol error" },
  { pattern: /Target (page|context|browser) has (crashed|been closed)/i, label: "the browser target crashing or closing unexpectedly" },
];

function matchInfraPattern(text: string): string | undefined {
  for (const { pattern, label } of INFRA_ERROR_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

export interface ClassifyFailureInput {
  failingTest: RunReportTest;
  runId: string;
  runReportHistory: RunReportHistory;
  suiteReview: SuiteReview | undefined;
  failureClassifications: FailureClassificationsFile;
}

/** `test.consoleMessages`/`test.failedNetworkRequests` are the actual sanitized text captured by
 * the Stage 06 reporter (normalizedReporter.ts), embedded inline in the run report JSON -- not a
 * path to a separate file. There is nothing else to link to for those two, so both point back at
 * the source run report JSON itself (which contains this exact test's full text) rather than
 * duplicating potentially large text into a second document. */
function buildEvidenceLinks(test: RunReportTest, runId: string): EvidenceLink[] {
  const links: EvidenceLink[] = [{ label: `Test source (line ${test.line})`, path: test.filePath }];
  if (test.failureScreenshotPath) links.push({ label: "Failure screenshot", path: test.failureScreenshotPath });
  if (test.tracePath) links.push({ label: "Trace", path: test.tracePath });
  if (test.videoPath) links.push({ label: "Video", path: test.videoPath });
  const runReportPath = `artifacts/playwright/runs/run-reports/${runId}.json`;
  if (test.consoleMessages) links.push({ label: `Console messages (see "${test.testId}" in the source run report)`, path: runReportPath });
  if (test.failedNetworkRequests) links.push({ label: `Failed network requests (see "${test.testId}" in the source run report)`, path: runReportPath });
  return links;
}

function firstFailedStepTitle(test: RunReportTest): string | undefined {
  const failedStep = test.steps.find((s) => s.status === "failed");
  return failedStep?.title;
}

/** Every OTHER run report on file (excluding `excludeRunId`) that also covered `testId`, oldest to
 * newest ignored (order doesn't matter -- every entry is inspected). */
function otherRunOutcomes(
  testId: string,
  excludeRunId: string,
  history: RunReportHistory,
): { runId: string; status: string; endedAt: string }[] {
  const outcomes: { runId: string; status: string; endedAt: string }[] = [];
  for (const report of history.reports) {
    if (report.runId === excludeRunId) continue;
    const test = report.tests.find((t) => t.testId === testId);
    if (test) outcomes.push({ runId: report.runId, status: test.status, endedAt: report.endedAt });
  }
  return outcomes;
}

const PASSING_STATUSES = new Set(["initial-pass", "retry-pass"]);

function siblingHealthNote(test: RunReportTest, suiteReview: SuiteReview | undefined): string {
  if (!suiteReview) {
    return "No suite review is available to cross-reference sibling test health for this requirement.";
  }
  if (test.requirementIds.length === 0) {
    return "This test declares no requirementIds, so no sibling-test cross-reference is possible.";
  }
  const siblings = suiteReview.tests.filter(
    (t) => t.testId !== test.testId && t.requirementIds.some((id) => test.requirementIds.includes(id)),
  );
  if (siblings.length === 0) {
    return `No other discovered test shares requirement(s) ${test.requirementIds.join(", ")} with this one.`;
  }
  const healthy = siblings.filter((t) => t.lastKnownResult && PASSING_STATUSES.has(t.lastKnownResult.status));
  return (
    `${healthy.length}/${siblings.length} sibling test(s) covering the same requirement(s) ` +
    `(${test.requirementIds.join(", ")}) currently show a healthy last-known result ` +
    `(${siblings.map((t) => `${t.testId}: ${t.lastKnownResult?.status ?? "never executed"}`).join("; ")}).`
  );
}

function findHandAuthoredOverride(
  test: RunReportTest,
  file: FailureClassificationsFile,
) {
  const candidates = file.classifications.filter((c) => c.testId === test.testId);
  // Prefer the most specific match: an entry whose errorFingerprint actually appears in this
  // failure's own error text, before falling back to a fingerprint-less (applies-to-any-failure-
  // of-this-test) entry.
  const fingerprinted = candidates.find(
    (c) => c.errorFingerprint && test.errorMessage && test.errorMessage.includes(c.errorFingerprint),
  );
  if (fingerprinted) return fingerprinted;
  return candidates.find((c) => !c.errorFingerprint);
}

export function classifyFailure(input: ClassifyFailureInput): MaintenanceFinding {
  const { failingTest: test, runId, runReportHistory, suiteReview, failureClassifications } = input;

  const evidenceLinks = buildEvidenceLinks(test, runId);
  const firstFailedStep = firstFailedStepTitle(test);
  const expectedBehavior = test.expectedOutcome?.trim() || test.objective?.trim() || "Not recorded in the run report (no expectedOutcome/objective metadata was captured for this test).";
  const observedBehavior =
    test.whyFailed?.trim() ||
    test.errorMessage?.trim() ||
    `Test ended with status "${test.status}" after ${test.attempts} attempt(s); no error message or explanation was recorded.`;
  const siblingNote = siblingHealthNote(test, suiteReview);

  const errorText = [test.errorMessage, test.sanitizedStackTrace, test.whyFailed].filter(Boolean).join("\n");

  // --- Mechanical tier 1: environment/infrastructure -------------------------------------------
  const infraPatternLabel = matchInfraPattern(errorText);
  if (test.status === "setup-failure" || infraPatternLabel) {
    const reason =
      test.status === "setup-failure"
        ? 'the Stage 06 run report itself recorded this test\'s status as "setup-failure" (a failure before the test body meaningfully ran, per RunResultStatusSchema)'
        : `this failure's own error text matched a known infrastructure signature: ${infraPatternLabel}`;
    return {
      testId: test.testId,
      runId,
      classification: "environment-or-infrastructure-problem",
      confidence: "high",
      expectedBehavior,
      observedBehavior,
      firstFailedStep,
      evidenceLinks,
      comparisonNotes: `Mechanical signal: ${reason}. ${siblingNote}`,
      evidenceForApplicationDefect: [],
      evidenceAgainstApplicationDefect: [`Mechanical signal: ${reason} -- the test body never meaningfully exercised application behavior.`],
      evidenceForTestDefect: [],
      evidenceAgainstTestDefect: [`Mechanical signal: ${reason} -- this is not a defect in the test's own assertions or logic.`],
      recommendedNextAction:
        "Investigate the test environment or infrastructure (see the matched signal above) and re-run once resolved. Not a candidate for /pw-repair-test -- there is nothing in the test itself to repair.",
      repairAllowed: false,
      repairAllowedFiles: [],
      suggestedDefectDescription: undefined,
      needsHumanReview: false,
      source: "mechanical",
    };
  }

  // --- Mechanical tier 2: intermittent/flaky (cross-run history) -------------------------------
  // Stage 09 audit finding (High, fixed): this used to require only "some OTHER run ever recorded
  // a pass" (`hasPassedElsewhere`), with no recency requirement at all. Since classifyFailure is
  // only ever invoked on an already-failing test, `FAILING_STATUSES.has(test.status)` in the old
  // condition was always true by construction -- so the entire mechanical signal collapsed to
  // "this test passed at least once, ever, in any run report on file." That misclassifies a real,
  // ongoing, deterministic application regression as "intermittent/flaky" the moment a SINGLE
  // pass exists anywhere in history, however old -- e.g. one pass from months ago followed by five
  // consecutive deterministic failures since a real regression was introduced. That is the exact
  // opposite of "intermittent" and, worse, `intermittent-flaky-behavior` sets `repairAllowed: true`,
  // handing a genuine, ongoing application bug to the controlled-repair workflow instead of routing
  // it toward `probable-application-defect`/hand-authored review -- directly undermining this
  // stage's own acceptance criterion ("A probable application bug remains visible and is not
  // 'fixed' by changing the test"). Reproduced live during this audit with exactly that scenario
  // before this fix (see the Stage 09 audit report). The fix requires the MOST RECENT other run on
  // file (by `endedAt`) to itself be a pass -- a real structural signal of oscillation ("this test
  // was healthy as recently as its last other recorded run, and is failing now"), not merely "a
  // pass exists somewhere, arbitrarily far back."
  const otherOutcomes = otherRunOutcomes(test.testId, runId, runReportHistory);
  const mostRecentOtherOutcome = [...otherOutcomes].sort(
    (a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt),
  )[0];
  const isGenuinelyOscillating = !!mostRecentOtherOutcome && PASSING_STATUSES.has(mostRecentOtherOutcome.status);
  if (isGenuinelyOscillating) {
    const historyDescription = otherOutcomes.map((o) => `${o.runId.slice(0, 8)}: ${o.status}`).join(", ");
    return {
      testId: test.testId,
      runId,
      classification: "intermittent-flaky-behavior",
      confidence: "medium",
      expectedBehavior,
      observedBehavior,
      firstFailedStep,
      evidenceLinks,
      comparisonNotes: `Mechanical signal: this test's run history includes both passing and failing outcomes across different real run reports (${historyDescription}, current run ${runId.slice(0, 8)}: ${test.status}). ${siblingNote}`,
      evidenceForApplicationDefect: [],
      evidenceAgainstApplicationDefect: [`Run history shows this test both passing and failing across different real runs (${historyDescription}), inconsistent with a deterministic application regression.`],
      evidenceForTestDefect: [],
      evidenceAgainstTestDefect: [`Run history shows this test both passing and failing across different real runs (${historyDescription}), inconsistent with a deterministic defect in the test's own logic.`],
      recommendedNextAction:
        "Re-run this test in isolation (and under --repeat-each) to confirm the flake, then determine whether a deterministic wait/synchronization fix is warranted. Requires explicit human review before any repair -- a mechanical history comparison is suggestive, not conclusive.",
      repairAllowed: true,
      repairAllowedFiles: [test.filePath],
      suggestedDefectDescription: undefined,
      needsHumanReview: true,
      source: "mechanical",
    };
  }

  // --- Hand-authored tier ------------------------------------------------------------------------
  const override = findHandAuthoredOverride(test, failureClassifications);
  if (override) {
    const forcedNoRepair: FailureClassification[] = ["probable-application-defect", "insufficient-evidence"];
    const repairAllowed = forcedNoRepair.includes(override.classification) ? false : override.repairAllowed;
    // TS-58: the same two categories that force repairAllowed: false must also force
    // needsHumanReview: true -- otherwise a hand-authored quality/failure-classifications.yaml entry
    // could set needsHumanReview: false on a probable-application-defect/insufficient-evidence
    // finding, letting it render as "no further review flagged" in the maintenance report even
    // though it's exactly the kind of finding a human is meant to be alerted to. This doesn't change
    // repairAllowed (already unconditionally clamped above), so it's a review-visibility fix, not a
    // write-scope change.
    const needsHumanReview = forcedNoRepair.includes(override.classification) ? true : override.needsHumanReview;
    return {
      testId: test.testId,
      runId,
      classification: override.classification,
      confidence: override.confidence,
      expectedBehavior,
      observedBehavior,
      firstFailedStep,
      evidenceLinks,
      comparisonNotes: `${override.rationale} ${siblingNote}`,
      evidenceForApplicationDefect: override.evidenceForApplicationDefect,
      evidenceAgainstApplicationDefect: override.evidenceAgainstApplicationDefect,
      evidenceForTestDefect: override.evidenceForTestDefect,
      evidenceAgainstTestDefect: override.evidenceAgainstTestDefect,
      recommendedNextAction: override.recommendedNextAction,
      repairAllowed,
      repairAllowedFiles: repairAllowed ? (override.repairAllowedFiles.length > 0 ? override.repairAllowedFiles : [test.filePath]) : [],
      suggestedDefectDescription: override.suggestedDefectDescription,
      needsHumanReview,
      source: "hand-authored",
    };
  }

  // --- Default: insufficient evidence -------------------------------------------------------------
  return {
    testId: test.testId,
    runId,
    classification: "insufficient-evidence",
    confidence: "low",
    expectedBehavior,
    observedBehavior,
    firstFailedStep,
    evidenceLinks,
    comparisonNotes:
      `No mechanical signal (run-report status, known infrastructure error pattern, or cross-run history) resolved this failure, ` +
      `and no entry in quality/failure-classifications.yaml matches testId "${test.testId}"` +
      (test.errorMessage ? ` and this failure's error text.` : `.`) +
      ` ${siblingNote}`,
    evidenceForApplicationDefect: [],
    evidenceAgainstApplicationDefect: [],
    evidenceForTestDefect: [],
    evidenceAgainstTestDefect: [],
    recommendedNextAction:
      "Manual investigation required. Once a human determines the actual cause, add a hand-authored entry to quality/failure-classifications.yaml (see quality/test-evaluations.yaml for the equivalent, established pattern) rather than guessing.",
    repairAllowed: false,
    repairAllowedFiles: [],
    suggestedDefectDescription: undefined,
    needsHumanReview: true,
    source: "insufficient-evidence-default",
  };
}
