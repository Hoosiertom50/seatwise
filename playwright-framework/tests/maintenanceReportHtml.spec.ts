/// <reference lib="dom" /> -- same rationale as suiteReviewHtml.spec.ts: assertions run against a
// real browser DOM (`page.setContent` + real locators), never a string/regex check against the
// raw HTML source, matching this project's "verify with real checks" standard.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { renderMaintenanceReportHtml } from "../reporting/renderMaintenanceReportHtml.js";
import type { MaintenanceReport, MaintenanceFinding } from "../metadata/schemas.js";

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

function finding(overrides: Partial<MaintenanceFinding> & { testId: string; classification: MaintenanceFinding["classification"] }): MaintenanceFinding {
  return {
    runId: "run-1",
    confidence: "medium",
    expectedBehavior: "expected behavior text",
    observedBehavior: "observed behavior text",
    evidenceLinks: [{ label: "Test source (line 10)", path: "e2e/tests/synthetic.spec.ts" }],
    comparisonNotes: "comparison notes text",
    evidenceForApplicationDefect: [],
    evidenceAgainstApplicationDefect: [],
    evidenceForTestDefect: [],
    evidenceAgainstTestDefect: [],
    recommendedNextAction: "recommended next action text",
    repairAllowed: false,
    repairAllowedFiles: [],
    needsHumanReview: true,
    source: "mechanical",
    ...overrides,
  };
}

function report(findings: MaintenanceFinding[], overrides: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    schemaVersion: "1.0.0",
    reportId: "report-synthetic-1",
    generatedAt: "2026-09-10T12:00:00.000Z",
    frameworkVersion: "0.9.0",
    gitCommit: "abc1234def5678900000000000000000000abcd",
    workingTreeClean: true,
    sourceRunId: "run-1",
    findings,
    ...overrides,
  };
}

test("a report with zero findings renders a clean-run message, no finding details", async () => {
  await page.setContent(renderMaintenanceReportHtml(report([])));
  await expect(page.getByText("No real failures were found in this run to triage.")).toBeVisible();
  await expect(page.locator("details.finding")).toHaveCount(0);
});

test("TS-57: renders the Git commit, silently, with no caveat when the working tree was clean", async () => {
  await page.setContent(renderMaintenanceReportHtml(report([], { gitCommit: "deadbeef1234567890000000000000000000abcd", workingTreeClean: true })));
  await expect(page.getByText("deadbeef1234567890000000000000000000abcd")).toBeVisible();
  await expect(page.getByText("working tree had uncommitted changes")).toHaveCount(0);
});

test("TS-57: flags an uncommitted working tree at report-generation time, the same way run/suite reports do", async () => {
  await page.setContent(renderMaintenanceReportHtml(report([], { gitCommit: "deadbeef1234567890000000000000000000abcd", workingTreeClean: false })));
  await expect(page.getByText("working tree had uncommitted changes at report-generation time")).toBeVisible();
});

test("each finding renders its classification, confidence, review/repair badges, and test ID", async () => {
  const html = renderMaintenanceReportHtml(
    report([
      finding({
        testId: "suite.infra-fail",
        classification: "environment-or-infrastructure-problem",
        confidence: "high",
        needsHumanReview: false,
        repairAllowed: false,
      }),
      finding({
        testId: "suite.test-defect",
        classification: "probable-test-defect",
        confidence: "high",
        needsHumanReview: true,
        repairAllowed: true,
        repairAllowedFiles: ["e2e/tests/synthetic.spec.ts"],
      }),
    ]),
  );
  await page.setContent(html);

  const rows = page.locator("details.finding");
  await expect(rows).toHaveCount(2);

  const infraRow = page.locator('details.finding[data-test-id="suite.infra-fail"]');
  await expect(infraRow.getByText("Environment or infrastructure problem")).toBeVisible();
  await expect(infraRow.getByText("Repair not allowed")).toBeVisible();
  await expect(infraRow.getByText("No further review flagged")).toBeVisible();

  const testDefectRow = page.locator('details.finding[data-test-id="suite.test-defect"]');
  await expect(testDefectRow.getByText("Probable test defect")).toBeVisible();
  await expect(testDefectRow.getByText("Needs human review")).toBeVisible();
  await expect(testDefectRow.getByText(/Repair candidate/)).toBeVisible();
  await expect(testDefectRow.locator(".repair-scope")).toContainText("e2e/tests/synthetic.spec.ts");
});

test("evidence-for/against lists render only when non-empty, and 'none recorded' otherwise", async () => {
  const html = renderMaintenanceReportHtml(
    report([
      finding({
        testId: "suite.with-evidence",
        classification: "probable-test-defect",
        evidenceForTestDefect: ["a stale locator was found in the diff"],
      }),
    ]),
  );
  await page.setContent(html);
  const row = page.locator('details.finding[data-test-id="suite.with-evidence"]');
  await row.locator("summary").click(); // <details> starts closed -- open it so its body enters the a11y tree
  await expect(row.getByText("a stale locator was found in the diff")).toBeVisible();
  await expect(row.getByText("For an application defect: none recorded.")).toBeVisible();
});

test("evidence links resolve to hrefs relative to the maintenance-report directory", async () => {
  const html = renderMaintenanceReportHtml(
    report([
      finding({
        testId: "suite.linked",
        classification: "probable-test-defect",
        evidenceLinks: [
          { label: "Test source (line 10)", path: "e2e/tests/synthetic.spec.ts" },
          { label: "Failure screenshot", path: "artifacts/playwright/runs/test-results/x/failure.png" },
        ],
      }),
    ]),
  );
  await page.setContent(html);
  const row = page.locator('details.finding[data-test-id="suite.linked"]');
  await row.locator("summary").click(); // <details> starts closed -- open it so its links enter the a11y tree
  await expect(row.getByRole("link", { name: "Test source (line 10)" })).toHaveAttribute("href", "../../../e2e/tests/synthetic.spec.ts");
  await expect(row.getByRole("link", { name: "Failure screenshot" })).toHaveAttribute("href", "../runs/test-results/x/failure.png");
});
