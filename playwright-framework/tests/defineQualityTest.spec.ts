import { test, expect } from "@playwright/test";
import {
  validateQualityTestMetadata,
  QualityTestMetadataError,
} from "../metadata/defineQualityTest.js";
import type { TestMetadata } from "../metadata/schemas.js";

function validMetadata(overrides: Partial<TestMetadata> = {}): TestMetadata {
  return {
    id: "framework.smoke.example",
    title: "example quality test",
    objective: "confirms the metadata wrapper accepts well-formed input",
    expectedOutcome: "no error is thrown",
    requirementIds: [],
    tags: ["@readonly", "@feature:framework", "@risk:low", "@suite:framework"],
    ...overrides,
  };
}

test.describe("validateQualityTestMetadata against the real tag taxonomy", () => {
  test("accepts well-formed metadata with valid tags", () => {
    expect(() => validateQualityTestMetadata(validMetadata())).not.toThrow();
  });

  test("rejects an unknown tag", () => {
    expect(() => validateQualityTestMetadata(validMetadata({ tags: ["@nonexistent-tag"] }))).toThrow(
      QualityTestMetadataError,
    );
  });

  test("rejects a tag set missing a required exactly-one dimension (data-impact)", () => {
    expect(() =>
      validateQualityTestMetadata(validMetadata({ tags: ["@feature:framework", "@risk:low"] })),
    ).toThrow(/data-impact/);
  });

  test("rejects a tag set with conflicting readonly and mutating tags", () => {
    expect(() =>
      validateQualityTestMetadata(
        validMetadata({ tags: ["@readonly", "@mutating", "@feature:framework", "@risk:low"] }),
      ),
    ).toThrow(/conflicting tags/);
  });

  test("rejects metadata failing schema validation (empty objective)", () => {
    expect(() => validateQualityTestMetadata(validMetadata({ objective: "" }))).toThrow(
      QualityTestMetadataError,
    );
  });
});
