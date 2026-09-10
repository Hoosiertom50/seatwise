import { test, expect } from "@playwright/test";
import { validateAllTestMetadata } from "../metadata/validateMetadata.js";
import type { RequirementsFile, TagTaxonomyFile, TestMetadata } from "../metadata/schemas.js";

const taxonomy: TagTaxonomyFile = {
  schemaVersion: "1.0.0",
  changeHistory: [{ date: "2026-01-01", change: "init" }],
  dimensions: [
    {
      name: "data-impact",
      description: "d",
      requirement: "exactly-one",
      tags: [
        { name: "@readonly", description: "d", productionEligible: true },
        { name: "@mutating", description: "d", productionEligible: false },
      ],
    },
  ],
  conflicts: [],
  aliases: [],
};

const requirements: RequirementsFile = {
  schemaVersion: "1.0.0",
  requirements: [
    {
      id: "REQ-1",
      title: "t",
      description: "d",
      sourceRefs: [],
      status: "confirmed",
      provenance: "p",
    },
  ],
};

function validTest(overrides: Partial<TestMetadata> = {}): TestMetadata {
  return {
    id: "test-1",
    title: "does a thing",
    objective: "confirms the thing happens",
    expectedOutcome: "the thing is visible",
    requirementIds: ["REQ-1"],
    tags: ["@readonly"],
    ...overrides,
  };
}

test.describe("validateAllTestMetadata", () => {
  test("a fully valid test produces no issues", () => {
    const summary = validateAllTestMetadata([validTest()], taxonomy, requirements);
    expect(summary.valid).toBe(true);
    expect(summary.issues).toEqual([]);
  });

  test("duplicate test IDs are a hard failure", () => {
    const summary = validateAllTestMetadata(
      [validTest({ id: "dup" }), validTest({ id: "dup" })],
      taxonomy,
      requirements,
    );
    expect(summary.valid).toBe(false);
    expect(summary.issues.some((i) => i.message.includes("duplicate test id"))).toBe(true);
  });

  test("empty objective is a hard failure", () => {
    const summary = validateAllTestMetadata([validTest({ objective: "" })], taxonomy, requirements);
    expect(summary.valid).toBe(false);
  });

  test("empty expectedOutcome is a hard failure", () => {
    const summary = validateAllTestMetadata(
      [validTest({ expectedOutcome: "   " })],
      taxonomy,
      requirements,
    );
    expect(summary.valid).toBe(false);
  });

  test("a reference to an unknown requirement is a hard failure", () => {
    const summary = validateAllTestMetadata(
      [validTest({ requirementIds: ["REQ-DOES-NOT-EXIST"] })],
      taxonomy,
      requirements,
    );
    expect(summary.valid).toBe(false);
    expect(summary.issues.some((i) => i.message.includes("unknown requirement"))).toBe(true);
  });

  test("no requirementIds is flagged needsHumanReview but does not fail validation", () => {
    const summary = validateAllTestMetadata([validTest({ requirementIds: [] })], taxonomy, requirements);
    expect(summary.valid).toBe(true);
    expect(summary.issues).toHaveLength(1);
    expect(summary.issues[0].needsHumanReview).toBe(true);
  });

  test("an invalid tag set is a hard failure", () => {
    const summary = validateAllTestMetadata(
      [validTest({ tags: ["@not-a-real-tag"] })],
      taxonomy,
      requirements,
    );
    expect(summary.valid).toBe(false);
  });

  test("a reference to a retired requirement is a hard failure (stale metadata) even though the requirement still exists", () => {
    const requirementsWithRetired: RequirementsFile = {
      ...requirements,
      requirements: [
        ...requirements.requirements,
        { id: "REQ-OLD", title: "t", description: "d", sourceRefs: [], status: "retired", provenance: "p" },
      ],
    };
    const summary = validateAllTestMetadata(
      [validTest({ requirementIds: ["REQ-OLD"] })],
      taxonomy,
      requirementsWithRetired,
    );
    expect(summary.valid).toBe(false);
    expect(summary.issues.some((i) => i.message.includes("retired requirement") && i.message.includes("stale metadata"))).toBe(
      true,
    );
    // A retired requirement is a different failure from an unknown one -- it must not also be
    // reported as "unknown requirement" (the requirement genuinely exists, just retired).
    expect(summary.issues.some((i) => i.message.includes("unknown requirement"))).toBe(false);
  });
});
