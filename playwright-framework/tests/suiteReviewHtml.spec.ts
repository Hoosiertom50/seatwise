/// <reference lib="dom" /> -- same rationale as runReportHtml.spec.ts: this file's assertions run
// against a real browser DOM (`page.setContent` + real locators), not a string/regex check against
// the HTML source, consistent with this project's "verify with real checks" standard. It launches
// its own throwaway Chromium instance directly (framework-unit has no browser configured), using
// the same PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH sandbox workaround as runReportHtml.spec.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { renderSuiteReviewHtml } from "../reporting/renderSuiteReviewHtml.js";
import { findMostRecentSuiteReviewPath } from "../coverage/diffSuiteReviews.js";
import { SuiteReviewSchema, type SuiteReview, type SuiteReviewTestEntry, type ScoreResultShape } from "../metadata/schemas.js";

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromiumExecutablePath });
});

test.afterAll(async () => {
  await browser.close();
});

test.beforeEach(async () => {
  page = await browser.newPage();
});

test.afterEach(async () => {
  await page.close();
});

function score(total: number, overrides: Partial<ScoreResultShape> = {}): ScoreResultShape {
  return { modelVersion: "1.0.0", total, source: "calculated", criteria: [], provisional: false, ...overrides };
}

function testEntry(overrides: Partial<SuiteReviewTestEntry> & { testId: string }): SuiteReviewTestEntry {
  return {
    title: overrides.testId,
    filePath: "e2e/tests/synthetic.spec.ts",
    line: 1,
    tags: ["@readonly", "@feature:guests", "@risk:normal"],
    requirementIds: ["REQ-SYNTHETIC"],
    objective: "Synthetic fixture for Stage 07 HTML-rendering verification.",
    expectedOutcome: "Renders with the correct badges, filters, and per-test fields.",
    valueScore: score(50),
    qualityScore: score(80),
    quarantined: false,
    recommendations: [],
    ...overrides,
  };
}

function makeReview(tests: SuiteReviewTestEntry[], overrides: Partial<SuiteReview> = {}): SuiteReview {
  return {
    schemaVersion: "1.0.0",
    reviewId: "synthetic-review-id",
    generatedAt: "2026-09-10T00:00:00.000Z",
    frameworkVersion: "0.7.0",
    gitCommit: "abc123",
    workingTreeClean: true,
    valueModelVersion: "1.0.0",
    freshnessWindowDays: 14,
    parseErrorCount: 0,
    requirementCoverage: { covered: 1, total: 18, denominatorLabel: "18 requirement(s) (2 excluded)" },
    riskWeightedCoverage: { covered: 2, total: 70, denominatorLabel: "x", weightingRule: "critical=4, high=3, normal=2, low=1" },
    dimensionCoverage: [{ dimension: "data-impact", countsByTag: { "@readonly": 1, "@mutating": 0 } }],
    requirementDetails: [],
    duplicateCandidates: [],
    tests,
    valueScoreDistribution: { Critical: 0, "High value": 0, Useful: 0, Limited: 0, Questionable: tests.length },
    qualityScoreDistribution: { "90-100": 0, "75-89": tests.length, "50-74": 0, "25-49": 0, "0-24": 0 },
    reviewQueue: [],
    ...overrides,
  };
}

test("renders no runtime errors for the real, just-generated suite review, if one exists on disk", async () => {
  const path = findMostRecentSuiteReviewPath(resolve(process.cwd(), "artifacts/playwright/runs/suite-reviews"));
  test.skip(!path, "no suite review has been generated yet -- run `pnpm pw:review` first");
  const review = SuiteReviewSchema.parse(JSON.parse(readFileSync(path!, "utf-8")));

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await expect(page.locator(".test-row")).toHaveCount(review.tests.length);
  await expect(page.locator("code", { hasText: review.reviewId })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("renders the meta table, coverage numbers, and one row per test with no runtime errors", async () => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  const review = makeReview([
    testEntry({ testId: "a.one", valueScore: score(20), qualityScore: score(90) }),
    testEntry({ testId: "a.two", valueScore: score(80), qualityScore: score(40) }),
  ]);
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await expect(page.locator(".test-row")).toHaveCount(2);
  await expect(page.getByText("1/18")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the client-side search filter really hides non-matching rows and shows matching ones", async () => {
  const review = makeReview([
    testEntry({ testId: "guests.view-existing", title: "view an existing guest" }),
    testEntry({ testId: "tables.assign-guest", title: "assign a guest to a table" }),
  ]);
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  const search = page.locator("#search");
  await search.fill("table");

  await expect(page.locator('.test-row[data-test-id="tables.assign-guest"]')).toBeVisible();
  await expect(page.locator('.test-row[data-test-id="guests.view-existing"]')).toBeHidden();

  await search.fill("");
  await expect(page.locator('.test-row[data-test-id="guests.view-existing"]')).toBeVisible();
});

test("the quarantined-only filter shows only quarantined tests", async () => {
  const review = makeReview([
    testEntry({ testId: "healthy.one", quarantined: false }),
    testEntry({ testId: "quarantined.one", quarantined: true, tags: ["@readonly", "@quarantined"] }),
  ]);
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await page.locator("#filter-quarantined").check();
  await expect(page.locator('.test-row[data-test-id="quarantined.one"]')).toBeVisible();
  await expect(page.locator('.test-row[data-test-id="healthy.one"]')).toBeHidden();

  await page.locator("#filter-quarantined").uncheck();
  await expect(page.locator('.test-row[data-test-id="healthy.one"]')).toBeVisible();
});

test("the risk-tag filter dropdown narrows to the selected risk tier", async () => {
  const review = makeReview([
    testEntry({ testId: "critical.one", tags: ["@readonly", "@risk:critical"] }),
    testEntry({ testId: "normal.one", tags: ["@readonly", "@risk:normal"] }),
  ]);
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await page.locator("#filter-risk").selectOption("@risk:critical");
  await expect(page.locator('.test-row[data-test-id="critical.one"]')).toBeVisible();
  await expect(page.locator('.test-row[data-test-id="normal.one"]')).toBeHidden();
});

test("the needs-human-review filter shows only tests with a provisional score", async () => {
  const review = makeReview([
    testEntry({ testId: "resolved.one", valueScore: score(50, { provisional: false }), qualityScore: score(90, { provisional: false }) }),
    testEntry({ testId: "provisional.one", valueScore: score(20, { provisional: true }), qualityScore: score(90, { provisional: false }) }),
  ]);
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await page.locator("#filter-needs-review").check();
  await expect(page.locator('.test-row[data-test-id="provisional.one"]')).toBeVisible();
  await expect(page.locator('.test-row[data-test-id="resolved.one"]')).toBeHidden();
});

test("the value-band and quality-band filter dropdowns narrow to the selected band", async () => {
  const review = makeReview([
    testEntry({ testId: "critical-value.one", valueScore: score(95, { band: "Critical" }), qualityScore: score(95) }),
    testEntry({ testId: "questionable-value.one", valueScore: score(10, { band: "Questionable" }), qualityScore: score(10) }),
  ]);
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await page.locator("#filter-value-band").selectOption("Critical");
  await expect(page.locator('.test-row[data-test-id="critical-value.one"]')).toBeVisible();
  await expect(page.locator('.test-row[data-test-id="questionable-value.one"]')).toBeHidden();

  await page.locator("#filter-value-band").selectOption("");
  await page.locator("#filter-quality-band").selectOption("0-24");
  await expect(page.locator('.test-row[data-test-id="questionable-value.one"]')).toBeVisible();
  await expect(page.locator('.test-row[data-test-id="critical-value.one"]')).toBeHidden();
});

test("renders the review queue with priority and reasons when present", async () => {
  const review = makeReview([testEntry({ testId: "queued.one" })], {
    reviewQueue: [{ testId: "queued.one", priority: 35, reasons: ["has never been executed."] }],
  });
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await expect(page.getByText("Priority 35")).toBeVisible();
  await expect(page.getByText("has never been executed.")).toBeVisible();
});

test("renders changes from the previous review when present", async () => {
  const review = makeReview([testEntry({ testId: "kept.one" })], {
    changesFromPreviousReview: {
      previousReviewId: "prior-review-id",
      previousGeneratedAt: "2026-09-01T00:00:00.000Z",
      addedTestIds: ["new.one"],
      removedTestIds: ["gone.one"],
      valueScoreChanges: [{ testId: "kept.one", previousTotal: 10, currentTotal: 20 }],
      qualityScoreChanges: [],
    },
  });
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await expect(page.getByText("prior-review-id")).toBeVisible();
  await expect(page.getByText("new.one")).toBeVisible();
  await expect(page.getByText("gone.one")).toBeVisible();
});

test("renders no runtime errors and shows the empty-state message when a review has zero tests", async () => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  const review = makeReview([]);
  const html = renderSuiteReviewHtml(review);
  await page.setContent(html);

  await expect(page.getByText("No tests were discovered.")).toBeVisible();
  await expect(page.locator(".test-row")).toHaveCount(0);
  expect(errors).toEqual([]);
});
