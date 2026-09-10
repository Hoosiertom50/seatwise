import { test, expect } from "@playwright/test";
import {
  TestValueModelFileSchema,
  ValueOverrideSchema,
  RequirementsFileSchema,
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
