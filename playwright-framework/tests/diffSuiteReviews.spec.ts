import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSuiteReviews, findMostRecentSuiteReviewPath } from "../coverage/diffSuiteReviews.js";
import type { SuiteReview, SuiteReviewTestEntry, ScoreResultShape } from "../metadata/schemas.js";

function score(total: number): ScoreResultShape {
  return { modelVersion: "1.0.0", total, source: "calculated", criteria: [], provisional: false };
}

function testEntry(testId: string, valueTotal: number, qualityTotal: number): SuiteReviewTestEntry {
  return {
    testId,
    title: testId,
    filePath: "e2e/tests/x.spec.ts",
    line: 1,
    tags: [],
    requirementIds: [],
    objective: "x",
    expectedOutcome: "x",
    valueScore: score(valueTotal),
    qualityScore: score(qualityTotal),
    quarantined: false,
    recommendations: [],
  };
}

function review(overrides: Partial<SuiteReview> = {}): SuiteReview {
  return {
    schemaVersion: "1.0.0",
    reviewId: "r1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    frameworkVersion: "0.7.0",
    gitCommit: "abc",
    workingTreeClean: true,
    valueModelVersion: "1.0.0",
    freshnessWindowDays: 14,
    parseErrorCount: 0,
    requirementCoverage: { covered: 0, total: 0, denominatorLabel: "x" },
    riskWeightedCoverage: { covered: 0, total: 0, denominatorLabel: "x", weightingRule: "x" },
    dimensionCoverage: [],
    requirementDetails: [],
    duplicateCandidates: [],
    tests: [],
    valueScoreDistribution: {},
    qualityScoreDistribution: {},
    reviewQueue: [],
    ...overrides,
  };
}

test.describe("diffSuiteReviews", () => {
  test("returns undefined when there is no previous review", () => {
    expect(diffSuiteReviews(undefined, review())).toBeUndefined();
  });

  test("detects added and removed tests", () => {
    const previous = review({ tests: [testEntry("kept", 10, 10), testEntry("removed", 10, 10)] });
    const current = { reviewId: "r2", generatedAt: "2026-02-01T00:00:00.000Z", tests: [testEntry("kept", 10, 10), testEntry("added", 10, 10)] };
    const diff = diffSuiteReviews(previous, current)!;
    expect(diff.addedTestIds).toEqual(["added"]);
    expect(diff.removedTestIds).toEqual(["removed"]);
    expect(diff.previousReviewId).toBe("r1");
  });

  test("detects value and quality score changes for tests present in both reviews", () => {
    const previous = review({ tests: [testEntry("t1", 20, 90)] });
    const current = { reviewId: "r2", generatedAt: "x", tests: [testEntry("t1", 35, 90)] };
    const diff = diffSuiteReviews(previous, current)!;
    expect(diff.valueScoreChanges).toEqual([{ testId: "t1", previousTotal: 20, currentTotal: 35 }]);
    expect(diff.qualityScoreChanges).toEqual([]); // quality unchanged -- not reported
  });

  test("a newly added test contributes no score-change entry (nothing to compare against)", () => {
    const previous = review({ tests: [] });
    const current = { reviewId: "r2", generatedAt: "x", tests: [testEntry("brand-new", 50, 50)] };
    const diff = diffSuiteReviews(previous, current)!;
    expect(diff.addedTestIds).toEqual(["brand-new"]);
    expect(diff.valueScoreChanges).toEqual([]);
    expect(diff.qualityScoreChanges).toEqual([]);
  });
});

test.describe("findMostRecentSuiteReviewPath", () => {
  test("returns undefined when the directory does not exist", () => {
    expect(findMostRecentSuiteReviewPath("/nonexistent/suite-reviews/dir")).toBeUndefined();
  });

  test("returns the most recently modified .json file, ignoring non-json files", () => {
    const dir = mkdtempSync(join(tmpdir(), "suite-review-diff-test-"));
    try {
      writeFileSync(join(dir, "older.json"), "{}");
      writeFileSync(join(dir, "notes.txt"), "not json");
      // Ensure a distinct, later mtime for the "newer" file.
      const newerPath = join(dir, "newer.json");
      writeFileSync(newerPath, "{}");
      const laterTime = new Date(Date.now() + 60_000);
      utimesSync(newerPath, laterTime, laterTime);

      const result = findMostRecentSuiteReviewPath(dir);
      expect(result).toBe(newerPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
