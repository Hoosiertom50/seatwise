import { test, expect } from "@playwright/test";
import {
  TestValueModelFileSchema,
  ValueOverrideSchema,
  RequirementsFileSchema,
  MaintenanceFindingSchema,
  MaintenanceReportSchema,
  FailureClassificationsFileSchema,
} from "../metadata/schemas.js";

function validModelFixture(overrides: Partial<Record<string, unknown>> = {}) {
  const criterion = (id: string, weight: number) => ({
    id,
    label: id,
    weight,
    question: "q?",
    anchors: { "0": "a", "25": "b", "50": "c", "75": "d", "100": "e" },
    example: "ex",
  });
  return {
    schemaVersion: "1.0.0",
    modelVersion: "1.0.0",
    effectiveDate: "2026-01-01",
    changeHistory: [{ date: "2026-01-01", modelVersion: "1.0.0", change: "init" }],
    valueCriteria: [criterion("a", 60), criterion("b", 40)],
    valueBands: [{ band: "ok", minScore: 0, maxScore: 100, meaning: "m" }],
    qualityCriteria: [criterion("c", 50), criterion("d", 50)],
    ...overrides,
  };
}

test.describe("TestValueModelFileSchema", () => {
  test("accepts a model whose value and quality weights each total 100", () => {
    const result = TestValueModelFileSchema.safeParse(validModelFixture());
    expect(result.success).toBe(true);
  });

  test("rejects a model whose valueCriteria weights do not total 100", () => {
    const fixture = validModelFixture();
    fixture.valueCriteria = [{ ...fixture.valueCriteria[0], weight: 60 }];
    const result = TestValueModelFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("valueCriteria"))).toBe(true);
    }
  });

  test("rejects a model whose qualityCriteria weights do not total 100", () => {
    const fixture = validModelFixture();
    fixture.qualityCriteria = [{ ...fixture.qualityCriteria[0], weight: 99 }];
    const result = TestValueModelFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("qualityCriteria"))).toBe(true);
    }
  });

  test("rejects a model missing required scoring anchors", () => {
    const fixture: Record<string, unknown> = validModelFixture();
    const criteria = fixture.valueCriteria as Array<Record<string, unknown>>;
    const bad: Record<string, unknown> = { ...criteria[0] };
    delete bad.anchors;
    fixture.valueCriteria = [bad, criteria[1]];
    const result = TestValueModelFileSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });
});

test.describe("ValueOverrideSchema", () => {
  test("requires criterionId for a criterion-score override", () => {
    const result = ValueOverrideSchema.safeParse({
      testId: "t1",
      overrideType: "criterion-score",
      value: 10,
      rationale: "r",
      approver: "human",
      date: "2026-01-01",
    });
    expect(result.success).toBe(false);
  });

  test("rejects criterionId set on a total-score override", () => {
    const result = ValueOverrideSchema.safeParse({
      testId: "t1",
      overrideType: "total-score",
      criterionId: "should-not-be-here",
      value: 10,
      rationale: "r",
      approver: "human",
      date: "2026-01-01",
    });
    expect(result.success).toBe(false);
  });

  test("accepts a well-formed total-score override", () => {
    const result = ValueOverrideSchema.safeParse({
      testId: "t1",
      overrideType: "total-score",
      value: 85,
      rationale: "r",
      approver: "human",
      date: "2026-01-01",
    });
    expect(result.success).toBe(true);
  });
});

test.describe("RequirementsFileSchema", () => {
  test("accepts an empty requirements list", () => {
    const result = RequirementsFileSchema.safeParse({ schemaVersion: "1.0.0", requirements: [] });
    expect(result.success).toBe(true);
  });

  test("rejects a requirement with an unknown status", () => {
    const result = RequirementsFileSchema.safeParse({
      schemaVersion: "1.0.0",
      requirements: [
        {
          id: "REQ-1",
          title: "t",
          description: "d",
          sourceRefs: [],
          status: "not-a-real-status",
          provenance: "p",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// Stage 09 -- DEC-027: replaces an earlier, incomplete placeholder schema that was never consumed
// anywhere in the codebase (see schemas.ts's own module doc above MaintenanceReportSchema).
test.describe("MaintenanceFindingSchema", () => {
  function validFindingFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      testId: "suite.some-test",
      runId: "run-1",
      classification: "probable-test-defect",
      confidence: "high",
      expectedBehavior: "e",
      observedBehavior: "o",
      evidenceLinks: [{ label: "Test source", path: "e2e/tests/suite.spec.ts" }],
      comparisonNotes: "n",
      evidenceForApplicationDefect: [],
      evidenceAgainstApplicationDefect: [],
      evidenceForTestDefect: ["stale locator"],
      evidenceAgainstTestDefect: [],
      recommendedNextAction: "fix the locator",
      repairAllowed: true,
      repairAllowedFiles: ["e2e/tests/suite.spec.ts"],
      needsHumanReview: false,
      source: "hand-authored",
      ...overrides,
    };
  }

  test("accepts a well-formed finding for a repairable classification", () => {
    const result = MaintenanceFindingSchema.safeParse(validFindingFixture());
    expect(result.success).toBe(true);
  });

  test("rejects an unknown classification value", () => {
    const result = MaintenanceFindingSchema.safeParse(validFindingFixture({ classification: "not-a-real-category" }));
    expect(result.success).toBe(false);
  });

  test("rejects repairAllowed: true when classification is probable-application-defect (schema-level invariant)", () => {
    const result = MaintenanceFindingSchema.safeParse(
      validFindingFixture({ classification: "probable-application-defect", repairAllowed: true }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "repairAllowed")).toBe(true);
    }
  });

  test("rejects repairAllowed: true when classification is insufficient-evidence (schema-level invariant)", () => {
    const result = MaintenanceFindingSchema.safeParse(
      validFindingFixture({ classification: "insufficient-evidence", repairAllowed: true }),
    );
    expect(result.success).toBe(false);
  });

  test("accepts repairAllowed: false for probable-application-defect", () => {
    const result = MaintenanceFindingSchema.safeParse(
      validFindingFixture({ classification: "probable-application-defect", repairAllowed: false, repairAllowedFiles: [] }),
    );
    expect(result.success).toBe(true);
  });
});

test.describe("MaintenanceReportSchema", () => {
  test("accepts a report with zero findings (a clean run)", () => {
    const result = MaintenanceReportSchema.safeParse({
      schemaVersion: "1.0.0",
      reportId: "report-1",
      generatedAt: "2026-09-10T12:00:00.000Z",
      frameworkVersion: "0.9.0",
      sourceRunId: "run-1",
      findings: [],
    });
    expect(result.success).toBe(true);
  });
});

test.describe("FailureClassificationsFileSchema", () => {
  test("accepts an empty classifications list", () => {
    const result = FailureClassificationsFileSchema.safeParse({ schemaVersion: "1.0.0", classifications: [] });
    expect(result.success).toBe(true);
  });

  test("accepts a well-formed override entry with an errorFingerprint", () => {
    const result = FailureClassificationsFileSchema.safeParse({
      schemaVersion: "1.0.0",
      classifications: [
        {
          testId: "suite.some-test",
          errorFingerprint: "ECONNREFUSED",
          evaluatedAt: "2026-09-10",
          evaluatedBy: "Human QA",
          classification: "environment-or-infrastructure-problem",
          confidence: "high",
          needsHumanReview: false,
          rationale: "r",
          recommendedNextAction: "n",
          repairAllowed: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an override missing rationale", () => {
    const result = FailureClassificationsFileSchema.safeParse({
      schemaVersion: "1.0.0",
      classifications: [
        {
          testId: "suite.some-test",
          evaluatedAt: "2026-09-10",
          evaluatedBy: "Human QA",
          classification: "test-data-problem",
          confidence: "medium",
          needsHumanReview: true,
          recommendedNextAction: "n",
          repairAllowed: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
