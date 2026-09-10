import { test, expect } from "@playwright/test";
import { computeScore } from "../scoring/computeScore.js";
import { computeValueScore } from "../scoring/valueScore.js";
import { computeQualityScore } from "../scoring/qualityScore.js";
import { bandForValueScore } from "../scoring/bands.js";
import { applyOverride } from "../scoring/applyOverride.js";
import type { CriterionJudgment } from "../scoring/types.js";
import type { TestValueModelFile } from "../metadata/schemas.js";

function anchors() {
  return { "0": "0", "25": "25", "50": "50", "75": "75", "100": "100" };
}

const modelV1: TestValueModelFile = {
  schemaVersion: "1.0.0",
  modelVersion: "1.0.0",
  effectiveDate: "2026-01-01",
  changeHistory: [{ date: "2026-01-01", modelVersion: "1.0.0", change: "init" }],
  valueCriteria: [
    { id: "a", label: "A", weight: 60, question: "q", anchors: anchors(), example: "e" },
    { id: "b", label: "B", weight: 40, question: "q", anchors: anchors(), example: "e" },
  ],
  valueBands: [
    { band: "Critical", minScore: 90, maxScore: 100, meaning: "m" },
    { band: "High value", minScore: 75, maxScore: 89, meaning: "m" },
    { band: "Useful", minScore: 50, maxScore: 74, meaning: "m" },
    { band: "Limited", minScore: 25, maxScore: 49, meaning: "m" },
    { band: "Questionable", minScore: 0, maxScore: 24, meaning: "m" },
  ],
  qualityCriteria: [
    { id: "x", label: "X", weight: 70, question: "q", anchors: anchors(), example: "e" },
    { id: "y", label: "Y", weight: 30, question: "q", anchors: anchors(), example: "e" },
  ],
};

// A second model version with different weights, to prove a model-version change changes results.
const modelV2: TestValueModelFile = {
  ...modelV1,
  modelVersion: "2.0.0",
  changeHistory: [
    ...modelV1.changeHistory,
    { date: "2026-02-01", modelVersion: "2.0.0", change: "rebalanced weights" },
  ],
  valueCriteria: [
    { id: "a", label: "A", weight: 30, question: "q", anchors: anchors(), example: "e" },
    { id: "b", label: "B", weight: 70, question: "q", anchors: anchors(), example: "e" },
  ],
};

function judgment(criterionId: string, points: number, extra: Partial<CriterionJudgment> = {}): CriterionJudgment {
  return { criterionId, points, rationale: "r", confidence: "high", needsHumanReview: false, ...extra };
}

test.describe("computeScore boundaries", () => {
  test("full marks on every criterion sums to 100", () => {
    const result = computeValueScore(modelV1, [judgment("a", 60), judgment("b", 40)]);
    expect(result.total).toBe(100);
    expect(result.band).toBe("Critical");
    expect(result.provisional).toBe(false);
    expect(result.source).toBe("calculated");
  });

  test("zero marks on every criterion sums to 0", () => {
    const result = computeValueScore(modelV1, [judgment("a", 0), judgment("b", 0)]);
    expect(result.total).toBe(0);
    expect(result.band).toBe("Questionable");
  });

  test("band boundaries: 89 is High value, 90 is Critical", () => {
    expect(bandForValueScore(89, modelV1)).toBe("High value");
    expect(bandForValueScore(90, modelV1)).toBe("Critical");
  });

  test("band boundaries: 24 is Questionable, 25 is Limited", () => {
    expect(bandForValueScore(24, modelV1)).toBe("Questionable");
    expect(bandForValueScore(25, modelV1)).toBe("Limited");
  });

  test("quality scores are never banded", () => {
    const result = computeQualityScore(modelV1, [judgment("x", 70), judgment("y", 30)]);
    expect(result.total).toBe(100);
    expect(result.band).toBeUndefined();
  });

  test("a criterion judged out of range throws rather than silently clamping", () => {
    expect(() => computeValueScore(modelV1, [judgment("a", 61), judgment("b", 40)])).toThrow(
      /outside its allowed range/,
    );
  });

  test("a judgment for an unknown criterion throws", () => {
    expect(() => computeValueScore(modelV1, [judgment("nope", 10)])).toThrow(/unknown criterion/);
  });

  test("no score depends on pass/fail status: judgments carry no such field and totals are pure arithmetic", () => {
    const result = computeScore({
      modelVersion: "1.0.0",
      criteria: modelV1.valueCriteria,
      judgments: [judgment("a", 60), judgment("b", 40)],
    });
    expect(result.total).toBe(100);
    // The type system itself enforces this: CriterionJudgment has no pass/fail field to read.
  });
});

test.describe("missing and incomplete information", () => {
  test("a criterion flagged needsHumanReview contributes 0 and marks the result provisional", () => {
    const result = computeValueScore(modelV1, [
      judgment("a", 60),
      { criterionId: "b", points: undefined, rationale: "no business data available", confidence: "low", needsHumanReview: true },
    ]);
    expect(result.provisional).toBe(true);
    expect(result.total).toBe(60);
    const bCriterion = result.criteria.find((c) => c.criterionId === "b");
    expect(bCriterion?.needsHumanReview).toBe(true);
    expect(bCriterion?.points).toBe(0);
  });

  test("a criterion with no judgment at all is treated as needsHumanReview, not a fabricated zero", () => {
    const result = computeValueScore(modelV1, [judgment("a", 60)]);
    expect(result.provisional).toBe(true);
    const bCriterion = result.criteria.find((c) => c.criterionId === "b");
    expect(bCriterion?.needsHumanReview).toBe(true);
  });
});

test.describe("model version changes", () => {
  test("the same judgments score differently under a rebalanced model version", () => {
    const v1Result = computeValueScore(modelV1, [judgment("a", 60), judgment("b", 20)]);
    const v2Result = computeValueScore(modelV2, [judgment("a", 30), judgment("b", 20)]);
    expect(v1Result.modelVersion).toBe("1.0.0");
    expect(v2Result.modelVersion).toBe("2.0.0");
    expect(v1Result.total).not.toBe(v2Result.total);
  });
});

test.describe("applyOverride", () => {
  test("a total-score override reports source=override with rationale/approver/date, and recomputes the band", () => {
    const calculated = computeValueScore(modelV1, [judgment("a", 0), judgment("b", 0)]);
    expect(calculated.band).toBe("Questionable");
    const overridden = applyOverride(
      calculated,
      {
        testId: "t1",
        overrideType: "total-score",
        value: 95,
        rationale: "known critical path, scoring model doesn't yet capture it",
        approver: "tom",
        date: "2026-03-01",
      },
      (total) => bandForValueScore(total, modelV1),
    );
    expect(overridden.source).toBe("override");
    expect(overridden.total).toBe(95);
    expect(overridden.band).toBe("Critical");
    expect(overridden.overrideRef).toEqual({
      testId: "t1",
      rationale: "known critical path, scoring model doesn't yet capture it",
      approver: "tom",
      date: "2026-03-01",
    });
    // The calculated result itself must be untouched.
    expect(calculated.source).toBe("calculated");
    expect(calculated.total).toBe(0);
  });

  test("a criterion-score override replaces just that criterion and re-derives the total", () => {
    const calculated = computeValueScore(modelV1, [judgment("a", 60), judgment("b", 0)]);
    expect(calculated.total).toBe(60);
    const overridden = applyOverride(calculated, {
      testId: "t1",
      overrideType: "criterion-score",
      criterionId: "b",
      value: 40,
      rationale: "human confirmed real business impact",
      approver: "tom",
      date: "2026-03-01",
    });
    expect(overridden.total).toBe(100);
    expect(overridden.source).toBe("override");
    const bCriterion = overridden.criteria.find((c) => c.criterionId === "b");
    expect(bCriterion?.points).toBe(40);
    expect(bCriterion?.needsHumanReview).toBe(false);
  });

  test("a criterion-score override exceeding the criterion's weight throws", () => {
    const calculated = computeValueScore(modelV1, [judgment("a", 60), judgment("b", 0)]);
    expect(() =>
      applyOverride(calculated, {
        testId: "t1",
        overrideType: "criterion-score",
        criterionId: "b",
        value: 999,
        rationale: "r",
        approver: "tom",
        date: "2026-03-01",
      }),
    ).toThrow(/exceeds criterion/);
  });

  test("a criterion-score override for an unknown criterion throws", () => {
    const calculated = computeValueScore(modelV1, [judgment("a", 60), judgment("b", 0)]);
    expect(() =>
      applyOverride(calculated, {
        testId: "t1",
        overrideType: "criterion-score",
        criterionId: "does-not-exist",
        value: 10,
        rationale: "r",
        approver: "tom",
        date: "2026-03-01",
      }),
    ).toThrow(/unknown criterion/);
  });

  test("overriding a provisional score with a criterion-score override can clear its provisional flag", () => {
    const calculated = computeValueScore(modelV1, [judgment("a", 60)]); // b is unjudged -> provisional
    expect(calculated.provisional).toBe(true);
    const overridden = applyOverride(calculated, {
      testId: "t1",
      overrideType: "criterion-score",
      criterionId: "b",
      value: 20,
      rationale: "human supplied the missing business context",
      approver: "tom",
      date: "2026-03-01",
    });
    expect(overridden.provisional).toBe(false);
    expect(overridden.total).toBe(80);
  });
});
