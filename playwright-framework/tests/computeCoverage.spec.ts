import { test, expect } from "@playwright/test";
import {
  computeRequirementCoverage,
  computeRiskWeightedCoverage,
  computeDimensionCoverage,
  classifyTestHealth,
  type CoverageTestInput,
} from "../coverage/computeCoverage.js";
import type { RequirementsFile, TagTaxonomyFile } from "../metadata/schemas.js";
import type { LastKnownResult } from "../coverage/runReportHistory.js";

function requirement(overrides: Partial<RequirementsFile["requirements"][number]>) {
  return {
    id: "REQ-X",
    title: "X",
    description: "desc",
    sourceRefs: [],
    status: "needs-human-review" as const,
    provenance: "test",
    ...overrides,
  };
}

test.describe("classifyTestHealth", () => {
  test("a @quarantined test is quarantined regardless of execution history", () => {
    expect(classifyTestHealth(["@quarantined"], { status: "initial-pass", runId: "r", endedAt: "x", ageDays: 0 }, 14)).toBe(
      "quarantined",
    );
  });

  test("no execution record at all is never-executed", () => {
    expect(classifyTestHealth(["@readonly"], undefined, 14)).toBe("never-executed");
  });

  test("older than the freshness window is stale, even if it last passed", () => {
    const result: LastKnownResult = { status: "initial-pass", runId: "r", endedAt: "x", ageDays: 30 };
    expect(classifyTestHealth(["@readonly"], result, 14)).toBe("stale");
  });

  test("a recent consistent-failure is failing, not healthy", () => {
    const result: LastKnownResult = { status: "consistent-failure", runId: "r", endedAt: "x", ageDays: 1 };
    expect(classifyTestHealth(["@readonly"], result, 14)).toBe("failing");
  });

  test("a recent initial-pass within the window is healthy", () => {
    const result: LastKnownResult = { status: "initial-pass", runId: "r", endedAt: "x", ageDays: 1 };
    expect(classifyTestHealth(["@readonly"], result, 14)).toBe("healthy");
  });

  test("a recent retry-pass (flaky but ultimately passed) within the window is healthy", () => {
    const result: LastKnownResult = { status: "retry-pass", runId: "r", endedAt: "x", ageDays: 1 };
    expect(classifyTestHealth(["@readonly"], result, 14)).toBe("healthy");
  });
});

test.describe("computeRequirementCoverage", () => {
  test("excludes placeholder and retired requirements from the denominator, and states so", () => {
    const requirements: RequirementsFile = {
      schemaVersion: "1.0.0",
      requirements: [
        requirement({ id: "REQ-A", status: "needs-human-review" }),
        requirement({ id: "REQ-B", status: "confirmed" }),
        requirement({ id: "REQ-PLACEHOLDER", status: "placeholder" }),
        requirement({ id: "REQ-RETIRED", status: "retired" }),
      ],
    };
    const tests: CoverageTestInput[] = [{ testId: "t1", tags: ["@readonly"], requirementIds: ["REQ-A"] }];
    const { bucket, details } = computeRequirementCoverage(requirements, tests, new Map());
    expect(bucket.total).toBe(2); // REQ-A + REQ-B only
    expect(bucket.covered).toBe(1); // only REQ-A has a covering test
    expect(bucket.denominatorLabel).toContain("2 requirement(s)");
    expect(bucket.denominatorLabel).toContain("2 \"placeholder\"/\"retired\"");
    expect(details.find((d) => d.requirementId === "REQ-B")?.coveringTestIds).toEqual([]);
  });

  test("a requirement covered only by unhealthy tests is flagged, distinct from fully uncovered", () => {
    const requirements: RequirementsFile = {
      schemaVersion: "1.0.0",
      requirements: [
        requirement({ id: "REQ-A", status: "confirmed" }),
        requirement({ id: "REQ-B", status: "confirmed" }),
      ],
    };
    const tests: CoverageTestInput[] = [
      { testId: "t1", tags: ["@readonly"], requirementIds: ["REQ-A"] },
      // REQ-B has no test at all
    ];
    const health = new Map([["t1", "quarantined" as const]]);
    const { details } = computeRequirementCoverage(requirements, tests, health);
    const reqA = details.find((d) => d.requirementId === "REQ-A")!;
    const reqB = details.find((d) => d.requirementId === "REQ-B")!;
    expect(reqA.coveredOnlyByUnhealthyTests).toBe(true); // covered, but only by a quarantined test
    expect(reqB.coveredOnlyByUnhealthyTests).toBe(false); // uncovered is a different bucket entirely
    expect(reqB.coveringTestIds).toEqual([]);
  });

  test("a requirement covered by at least one healthy test is not flagged", () => {
    const requirements: RequirementsFile = {
      schemaVersion: "1.0.0",
      requirements: [requirement({ id: "REQ-A", status: "confirmed" })],
    };
    const tests: CoverageTestInput[] = [
      { testId: "t1", tags: ["@readonly"], requirementIds: ["REQ-A"] },
      { testId: "t2", tags: ["@mutating"], requirementIds: ["REQ-A"] },
    ];
    const health = new Map<string, "healthy" | "quarantined">([
      ["t1", "quarantined"],
      ["t2", "healthy"],
    ]);
    const { details } = computeRequirementCoverage(requirements, tests, health);
    expect(details[0].coveredOnlyByUnhealthyTests).toBe(false);
  });
});

test.describe("computeRiskWeightedCoverage", () => {
  test("an uncovered requirement is weighted as if @risk:critical (conservative, never inflated)", () => {
    const requirements: RequirementsFile = {
      schemaVersion: "1.0.0",
      requirements: [
        requirement({ id: "REQ-A", status: "confirmed" }),
        requirement({ id: "REQ-B", status: "confirmed" }),
      ],
    };
    const tests: CoverageTestInput[] = [
      { testId: "t1", tags: ["@readonly", "@risk:low"], requirementIds: ["REQ-A"] },
    ];
    const { bucket: reqBucket, details } = computeRequirementCoverage(requirements, tests, new Map());
    const { bucket: riskBucket } = computeRiskWeightedCoverage(details, tests);
    // REQ-A: covered, weighted by its test's own @risk:low = 1. REQ-B: uncovered, weighted 4 (critical).
    expect(riskBucket.covered).toBe(1);
    expect(riskBucket.total).toBe(1 + 4);
    expect(riskBucket.weightingRule).toContain("critical");
    // Sanity: risk-weighted % must never exceed plain requirement-coverage % for the same data.
    const plainPct = reqBucket.covered / reqBucket.total;
    const riskPct = riskBucket.covered / riskBucket.total;
    expect(riskPct).toBeLessThanOrEqual(plainPct);
  });

  test("a requirement covered by multiple tests uses the HIGHEST risk tier among them", () => {
    const requirements: RequirementsFile = {
      schemaVersion: "1.0.0",
      requirements: [requirement({ id: "REQ-A", status: "confirmed" })],
    };
    const tests: CoverageTestInput[] = [
      { testId: "t1", tags: ["@readonly", "@risk:low"], requirementIds: ["REQ-A"] },
      { testId: "t2", tags: ["@mutating", "@risk:critical"], requirementIds: ["REQ-A"] },
    ];
    const { details } = computeRequirementCoverage(requirements, tests, new Map());
    const { bucket } = computeRiskWeightedCoverage(details, tests);
    expect(bucket.covered).toBe(4); // critical, not low
    expect(bucket.total).toBe(4);
  });
});

test.describe("computeDimensionCoverage", () => {
  test("counts each dimension's tags independently, including zero-use tags", () => {
    const taxonomy: TagTaxonomyFile = {
      schemaVersion: "1.0.0",
      changeHistory: [{ date: "2026-01-01", change: "x" }],
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
        {
          name: "role",
          description: "d",
          requirement: "optional",
          tags: [{ name: "@role:anonymous", description: "d", productionEligible: true }],
        },
      ],
      conflicts: [],
      aliases: [],
    };
    const tests: CoverageTestInput[] = [
      { testId: "t1", tags: ["@readonly"], requirementIds: [] },
      { testId: "t2", tags: ["@readonly"], requirementIds: [] },
      { testId: "t3", tags: ["@mutating"], requirementIds: [] },
    ];
    const result = computeDimensionCoverage(taxonomy, tests);
    const dataImpact = result.find((d) => d.dimension === "data-impact")!;
    expect(dataImpact.countsByTag["@readonly"]).toBe(2);
    expect(dataImpact.countsByTag["@mutating"]).toBe(1);
    const role = result.find((d) => d.dimension === "role")!;
    expect(role.countsByTag["@role:anonymous"]).toBe(0); // never used -- disclosed as 0, not omitted
  });
});
