import { test, expect } from "@playwright/test";
import { evaluateTestQuality, evaluateTestValue, type EvaluationContext, type EvaluationTestInput } from "../evaluation/evaluateTest.js";
import { detectDuplicates, SIMILARITY_THRESHOLD } from "../coverage/detectDuplicates.js";
import type { RequirementsFile, TestEvaluationsFile } from "../metadata/schemas.js";
import type { LatestRunReportEntry } from "../coverage/runReportHistory.js";

const EMPTY_REQUIREMENTS: RequirementsFile = { schemaVersion: "1.0.0", requirements: [] };

function testInput(overrides: Partial<EvaluationTestInput> = {}): EvaluationTestInput {
  return {
    testId: "guest-viewing.guest-list-shows-existing-guests",
    filePath: "e2e/tests/guest-viewing.spec.ts",
    tags: ["@readonly", "@feature:guests", "@risk:normal", "@suite:regression"],
    requirementIds: ["REQ-GUEST-LIST-MANAGEMENT"],
    objective:
      "Confirms a signed-in planner can open the Guests tab and see a guest that already exists on their wedding.",
    ...overrides,
  };
}

const SHARED_FIXTURE_SOURCE = `
import { test, expect } from "../fixtures/index.js";

test("shows existing guests", async ({ weddingGuestsPage, evidence }) => {
  const row = weddingGuestsPage.guestRow("Jamie");
  await row.expectVisible();
  await expect.poll(() => row.firstName()).toBe("Jamie");
  evidence.checkpoint("guest row visible");
});
`;

const NON_FIXTURE_SOURCE = `
import { test, expect } from "@playwright/test";

test("shows existing guests", async ({ page }) => {
  await page.goto("/guests");
  await expect(page.locator("text=Jamie")).toBeVisible();
});
`;

const FIXED_WAIT_SOURCE = `
import { test, expect } from "../fixtures/index.js";

test("shows existing guests", async ({ page, evidence }) => {
  await page.waitForTimeout(2000);
  await expect(page.locator("text=Jamie")).toBeVisible();
  evidence.checkpoint("done");
});
`;

const RAW_SELECTOR_SOURCE = `
import { test, expect } from "../fixtures/index.js";

test("shows existing guests", async ({ page, evidence }) => {
  await page.click("#guests-tab");
  await expect(page.locator("text=Jamie")).toBeVisible();
  evidence.checkpoint("done");
});
`;

const EMPTY_TEST_EVALUATIONS: TestEvaluationsFile = {
  schemaVersion: "1.0.0",
  modelVersion: "1.0.0",
  evaluations: [],
};

const WITH_HAND_AUTHORED_ENTRY: TestEvaluationsFile = {
  schemaVersion: "1.0.0",
  modelVersion: "1.0.0",
  evaluations: [
    {
      testId: "guest-viewing.guest-list-shows-existing-guests",
      evaluatedAt: "2026-01-01",
      evaluatedBy: "human:tom",
      valueJudgments: [
        {
          criterionId: "security-compliance-data-integrity",
          points: 5,
          rationale: "Read-only fetch scoped to the managed wedding; no cross-account isolation assertion made.",
          confidence: "medium",
          needsHumanReview: false,
        },
      ],
      qualityJudgments: [
        {
          criterionId: "assertion-strength-and-objective-traceability",
          points: 19,
          rationale: "Assertions read directly from source: firstName/lastName/rsvpStatus checks match the objective.",
          confidence: "high",
          needsHumanReview: false,
        },
      ],
    },
  ],
};

function makeContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const test1 = overrides.test ?? testInput();
  return {
    test: test1,
    sourceText: SHARED_FIXTURE_SOURCE,
    allTests: [test1],
    requirements: EMPTY_REQUIREMENTS,
    testEvaluations: EMPTY_TEST_EVALUATIONS,
    latestRunReportEntry: undefined,
    ...overrides,
  };
}

function findJudgment(judgments: ReturnType<typeof evaluateTestQuality>, criterionId: string) {
  const j = judgments.find((x) => x.criterionId === criterionId);
  if (!j) throw new Error(`no judgment for ${criterionId}`);
  return j;
}

test.describe("evaluateTestQuality — independence-and-parallel-safety", () => {
  test("full marks and no human review when the test uses the shared fixture architecture", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: SHARED_FIXTURE_SOURCE }));
    const j = findJudgment(judgments, "independence-and-parallel-safety");
    expect(j.points).toBe(20);
    expect(j.needsHumanReview).toBe(false);
  });

  test("needsHumanReview when the test does not import the shared fixtures module", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: NON_FIXTURE_SOURCE }));
    const j = findJudgment(judgments, "independence-and-parallel-safety");
    expect(j.points).toBeUndefined();
    expect(j.needsHumanReview).toBe(true);
  });
});

test.describe("evaluateTestQuality — test-data-setup-and-cleanup", () => {
  test("scores 8/10 (not full marks) when using shared fixtures, citing the account-cleanup gap", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: SHARED_FIXTURE_SOURCE }));
    const j = findJudgment(judgments, "test-data-setup-and-cleanup");
    expect(j.points).toBe(8);
    expect(j.needsHumanReview).toBe(false);
    expect(j.rationale).toContain("account");
  });

  test("needsHumanReview when not using shared fixtures", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: NON_FIXTURE_SOURCE }));
    const j = findJudgment(judgments, "test-data-setup-and-cleanup");
    expect(j.points).toBeUndefined();
    expect(j.needsHumanReview).toBe(true);
  });
});

test.describe("evaluateTestQuality — deterministic-waiting-and-state-control", () => {
  test("full 15 points when pw:lint-tests finds no fixed-wait violations", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: SHARED_FIXTURE_SOURCE }));
    const j = findJudgment(judgments, "deterministic-waiting-and-state-control");
    expect(j.points).toBe(15);
    expect(j.needsHumanReview).toBe(false);
  });

  test("docked points when a waitForTimeout violation is present, and it is never flagged needsHumanReview", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: FIXED_WAIT_SOURCE }));
    const j = findJudgment(judgments, "deterministic-waiting-and-state-control");
    expect(j.points).toBe(10); // 15 - 1*5
    expect(j.needsHumanReview).toBe(false);
    expect(j.rationale).toContain("1 fixed-wait violation");
  });
});

test.describe("evaluateTestQuality — page-component-object-and-locator-design", () => {
  test("full 15 points when pw:lint-tests finds no raw-selector violations", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: SHARED_FIXTURE_SOURCE }));
    const j = findJudgment(judgments, "page-component-object-and-locator-design");
    expect(j.points).toBe(15);
  });

  test("docked points when raw page.click(...)/page.locator(...) calls are present", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: RAW_SELECTOR_SOURCE }));
    const j = findJudgment(judgments, "page-component-object-and-locator-design");
    // RAW_SELECTOR_SOURCE has two raw-selector-method call sites: page.click(...) AND the
    // page.locator(...) inside expect(...) ("locator" is itself a raw-selector method) -- 15 - 2*5.
    expect(j.points).toBe(5);
    expect(j.needsHumanReview).toBe(false);
  });
});

test.describe("evaluateTestQuality — assertion-strength-and-objective-traceability (hand-authored)", () => {
  test("uses the hand-authored quality/test-evaluations.yaml entry when present", () => {
    const judgments = evaluateTestQuality(makeContext({ testEvaluations: WITH_HAND_AUTHORED_ENTRY }));
    const j = findJudgment(judgments, "assertion-strength-and-objective-traceability");
    expect(j.points).toBe(19);
    expect(j.needsHumanReview).toBe(false);
    expect(j.confidence).toBe("high");
  });

  test("falls back to needsHumanReview with an explanatory rationale when no entry exists", () => {
    const judgments = evaluateTestQuality(makeContext({ testEvaluations: EMPTY_TEST_EVALUATIONS }));
    const j = findJudgment(judgments, "assertion-strength-and-objective-traceability");
    expect(j.points).toBeUndefined();
    expect(j.needsHumanReview).toBe(true);
    expect(j.rationale).toContain("quality/test-evaluations.yaml");
  });
});

test.describe("evaluateTestQuality — readability-and-diagnostic-steps", () => {
  test("reads the step count from the latest run report when one exists", () => {
    const entry: LatestRunReportEntry = {
      runId: "r1",
      endedAt: "2026-01-01T00:00:00.000Z",
      ageDays: 1,
      test: {
        testId: "guest-viewing.guest-list-shows-existing-guests",
        title: "t",
        filePath: "e2e/tests/x.spec.ts",
        line: 1,
        tags: [],
        requirementIds: [],
        status: "initial-pass",
        durationMs: 1,
        attempts: 1,
        steps: [
          { title: "Arrange", category: "test.step", durationMs: 1, status: "passed" },
          { title: "Act", category: "test.step", durationMs: 1, status: "passed" },
          { title: "Assert", category: "test.step", durationMs: 1, status: "passed" },
        ],
        assertionCount: 3,
        successCheckpoints: [],
      },
    };
    const judgments = evaluateTestQuality(makeContext({ latestRunReportEntry: entry }));
    const j = findJudgment(judgments, "readability-and-diagnostic-steps");
    expect(j.points).toBe(10); // 3 steps
    expect(j.confidence).toBe("high");
    expect(j.rationale).toContain("run report");
  });

  test("falls back to a source scan (medium confidence) when no run report exists", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: SHARED_FIXTURE_SOURCE, latestRunReportEntry: undefined }));
    const j = findJudgment(judgments, "readability-and-diagnostic-steps");
    // SHARED_FIXTURE_SOURCE has zero test.step(...) calls.
    expect(j.points).toBe(0);
    expect(j.confidence).toBe("medium");
    expect(j.rationale).toContain("source scan");
  });
});

test.describe("evaluateTestQuality — evidence-and-failure-diagnostics", () => {
  test("full 5 points when the run report recorded a success checkpoint", () => {
    const entry: LatestRunReportEntry = {
      runId: "r1",
      endedAt: "2026-01-01T00:00:00.000Z",
      ageDays: 1,
      test: {
        testId: "t",
        title: "t",
        filePath: "e2e/tests/x.spec.ts",
        line: 1,
        tags: [],
        requirementIds: [],
        status: "initial-pass",
        durationMs: 1,
        attempts: 1,
        steps: [],
        assertionCount: 1,
        successCheckpoints: [
          { name: "guest row visible", screenshotPath: "shots/a.png", validationDescription: "Jamie" },
        ],
      },
    };
    const judgments = evaluateTestQuality(makeContext({ latestRunReportEntry: entry }));
    const j = findJudgment(judgments, "evidence-and-failure-diagnostics");
    expect(j.points).toBe(5);
  });

  test("without a run report, source calling evidence.checkpoint() earns partial (4) rather than full credit", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: SHARED_FIXTURE_SOURCE, latestRunReportEntry: undefined }));
    const j = findJudgment(judgments, "evidence-and-failure-diagnostics");
    expect(j.points).toBe(4);
  });

  test("without a run report and no evidence.checkpoint() call, the lowest score applies", () => {
    const judgments = evaluateTestQuality(makeContext({ sourceText: NON_FIXTURE_SOURCE, latestRunReportEntry: undefined }));
    const j = findJudgment(judgments, "evidence-and-failure-diagnostics");
    expect(j.points).toBe(1);
  });
});

test.describe("evaluateTestQuality — metadata-completeness-and-standards-compliance", () => {
  test("awards full 5 when the objective is specific (>=40 chars) and requirementIds is populated", () => {
    const judgments = evaluateTestQuality(makeContext());
    const j = findJudgment(judgments, "metadata-completeness-and-standards-compliance");
    expect(j.points).toBe(5);
  });

  test("docks points for a brief objective and empty requirementIds", () => {
    const judgments = evaluateTestQuality(
      makeContext({ test: testInput({ objective: "it works", requirementIds: [] }) }),
    );
    const j = findJudgment(judgments, "metadata-completeness-and-standards-compliance");
    expect(j.points).toBe(1);
  });
});

test.describe("evaluateTestValue — business criteria are always flagged needsHumanReview", () => {
  for (const criterionId of [
    "business-criticality",
    "user-impact-and-frequency",
    "risk-and-defect-likelihood",
    "release-decision-usefulness",
  ]) {
    test(`${criterionId} is undefined/needsHumanReview even with a populated requirementIds`, () => {
      const judgments = evaluateTestValue(makeContext());
      const j = findJudgment(judgments, criterionId);
      expect(j.points).toBeUndefined();
      expect(j.needsHumanReview).toBe(true);
    });
  }

  test("the rationale is more specific when the test cites zero requirementIds", () => {
    const judgments = evaluateTestValue(makeContext({ test: testInput({ requirementIds: [] }) }));
    const j = findJudgment(judgments, "business-criticality");
    expect(j.rationale).toContain("declares no requirementIds");
  });
});

test.describe("evaluateTestValue — security-compliance-data-integrity (hand-authored)", () => {
  test("uses the hand-authored entry when present", () => {
    const judgments = evaluateTestValue(makeContext({ testEvaluations: WITH_HAND_AUTHORED_ENTRY }));
    const j = findJudgment(judgments, "security-compliance-data-integrity");
    expect(j.points).toBe(5);
    expect(j.needsHumanReview).toBe(false);
  });

  test("falls back to needsHumanReview when no entry exists", () => {
    const judgments = evaluateTestValue(makeContext());
    const j = findJudgment(judgments, "security-compliance-data-integrity");
    expect(j.points).toBeUndefined();
    expect(j.needsHumanReview).toBe(true);
  });
});

test.describe("evaluateTestValue — unique-coverage", () => {
  test("full 15 points when no other discovered test overlaps on requirement+data-impact+feature+objective", () => {
    const other = testInput({
      testId: "table-assignments.assigns-guest-to-table",
      requirementIds: ["REQ-TABLE-ASSIGNMENT"],
      tags: ["@mutating", "@feature:tables", "@risk:normal"],
      objective: "Confirms a planner can assign a guest to a table.",
    });
    const mine = testInput();
    const judgments = evaluateTestValue(makeContext({ test: mine, allTests: [mine, other] }));
    const j = findJudgment(judgments, "unique-coverage");
    expect(j.points).toBe(15);
    expect(j.needsHumanReview).toBe(false);
  });

  test("the real guest-viewing/guest-management pair is NOT considered overlapping (different data-impact)", () => {
    const viewing = testInput();
    const management = testInput({
      testId: "guest-management.add-guest-appears-in-list",
      tags: ["@mutating", "@feature:guests", "@risk:normal", "@suite:regression"],
      objective: "Confirms a signed-in planner can add a guest and immediately see it reflected in the guest list.",
    });
    const judgments = evaluateTestValue(makeContext({ test: viewing, allTests: [viewing, management] }));
    const j = findJudgment(judgments, "unique-coverage");
    expect(j.points).toBe(15);
  });

  test("reduced, proportional points when another test genuinely overlaps on every dimension", () => {
    const mine = testInput();
    const overlapping = testInput({
      testId: "guest-viewing.duplicate-of-list-view",
      objective:
        "Confirms a signed-in planner can open the Guests tab and see a guest that already exists on their wedding.",
    });
    const judgments = evaluateTestValue(makeContext({ test: mine, allTests: [mine, overlapping] }));
    const j = findJudgment(judgments, "unique-coverage");
    expect(j.points).toBe(8); // round(15 / (1 + 1))
    expect(j.needsHumanReview).toBe(false);
    expect(j.rationale).toContain("guest-viewing.duplicate-of-list-view");
  });

  // Stage 07 audit, Finding 1 (High, fixed): unique-coverage's own overlap check used to hardcode
  // a DIFFERENT similarity threshold (0.3) from detectDuplicates.ts's SIMILARITY_THRESHOLD (0.5) --
  // even though PLAYWRIGHT_TESTING.md documents unique-coverage as "reusing the identical
  // comparison" as duplicate detection. That let a pair of tests with objective similarity between
  // 0.3 and 0.5 be treated as "overlapping" here (reducing unique-coverage's points, and saying so
  // in its rationale) while detectDuplicates simultaneously reported the exact same pair as NOT a
  // duplicate candidate -- a self-contradictory report. This locks the two mechanisms to the one
  // shared threshold going forward.
  test("a pair whose objective similarity sits strictly between the old, drifted 0.3 threshold and the real 0.5 threshold is NOT treated as overlapping (matches detectDuplicates exactly)", () => {
    const objA =
      "Confirms a signed-in planner can view an existing guest already present on their wedding's guest list with accurate details.";
    const objB =
      "Confirms a signed-in planner can filter the guest list to quickly find one particular guest already on their wedding.";

    const testA = testInput({ testId: "guest-viewing.view-existing", objective: objA });
    const testB = testInput({ testId: "guest-viewing.filter-existing", objective: objB });

    // Sanity: prove this fixture pair's similarity genuinely lands in the gap this finding
    // exploited (>= the old 0.3, < the real 0.5) -- otherwise this test would prove nothing.
    const dupCandidatesForSanity = detectDuplicates([testA, testB]);
    expect(dupCandidatesForSanity).toHaveLength(0); // below SIMILARITY_THRESHOLD (0.5)
    expect(SIMILARITY_THRESHOLD).toBe(0.5);

    const judgments = evaluateTestValue(makeContext({ test: testA, allTests: [testA, testB] }));
    const j = findJudgment(judgments, "unique-coverage");
    // Must agree with detectDuplicates: no overlap found, full marks, not the reduced/proportional path.
    expect(j.points).toBe(15);
    expect(j.needsHumanReview).toBe(false);
    expect(j.rationale).not.toContain("filter-existing");
  });
});
