/// <reference lib="dom" /> -- this file's own `page.evaluate(() => getComputedStyle(...))` calls
// (the contrast-ratio test below) run in a real browser context and need `document`/
// `getComputedStyle` typed; the project's shared tsconfig.json deliberately has no "dom" in its
// `lib` (it's a Node-side TypeScript project, not a browser one), so this reference is scoped to
// this one file rather than widening every other file's global type surface.
//
// Stage 06 acceptance criterion: "Representative pass, assertion failure, timeout, retry-pass,
// skip, and setup failure render correctly." This exercises `renderRunReportHtml` against
// synthetic `RunReport` fixtures (not a real Playwright run -- Stage 06's other manual verification
// already covered that, see PLAYWRIGHT_TESTING.md) and asserts against the rendered markup through
// a REAL browser DOM (`page.setContent` + real locators), consistent with this project's "verify
// with real checks, not just assertions on strings" standard -- a plain string/regex check against
// the HTML source would not catch a markup mistake that happens to still contain the right
// substrings in the wrong place, or a script error that breaks the client-side filter.
//
// This project has no browser configured for the `framework-unit` project (it's plain
// TypeScript-unit tests -- see playwright.config.ts), so this file launches its own throwaway
// Chromium instance directly, same sandbox workaround `playwright.config.ts` already documents for
// the `chromium` project (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH), and tears it down afterwards.
import { test, expect } from "@playwright/test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { renderRunReportHtml } from "../reporting/renderRunReportHtml.js";
import type { RunReport, RunReportTest } from "../metadata/schemas.js";

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

/** An exact (not substring) text match, safe for labels containing regex-special characters like
 * the parentheses in "Passed on retry (flaky)". */
function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

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

function makeTest(overrides: Partial<RunReportTest> & Pick<RunReportTest, "testId" | "status">): RunReportTest {
  return {
    title: `synthetic test for ${overrides.status}`,
    filePath: "e2e/tests/synthetic.spec.ts",
    line: 1,
    tags: ["@readonly"],
    requirementIds: ["REQ-SYNTHETIC"],
    objective: "Synthetic fixture for Stage 06 HTML-rendering verification.",
    expectedOutcome: "Renders with the correct status badge and summary count.",
    durationMs: 100,
    attempts: 1,
    steps: [],
    assertionCount: 1,
    successCheckpoints: [],
    ...overrides,
  };
}

function makeReport(tests: RunReportTest[]): RunReport {
  const counts = {
    initialPass: tests.filter((t) => t.status === "initial-pass").length,
    retryPass: tests.filter((t) => t.status === "retry-pass").length,
    consistentFailure: tests.filter((t) => t.status === "consistent-failure").length,
    timeout: tests.filter((t) => t.status === "timeout").length,
    skipped: tests.filter((t) => t.status === "skipped").length,
    expectedFailure: tests.filter((t) => t.status === "expected-failure").length,
    quarantined: tests.filter((t) => t.status === "quarantined").length,
    setupFailure: tests.filter((t) => t.status === "setup-failure").length,
  };
  return {
    schemaVersion: "1.0.0",
    runId: "synthetic-run-id",
    generatedAt: "2026-09-10T00:00:00.000Z",
    startedAt: "2026-09-10T00:00:00.000Z",
    endedAt: "2026-09-10T00:00:01.000Z",
    durationMs: 1000,
    initiator: "runReportHtml.spec.ts",
    environment: "local",
    baseUrl: "http://localhost:3000",
    gitCommit: "0000000000000000000000000000000000000000",
    workingTreeClean: true,
    playwrightVersion: "1.63.0",
    nodeVersion: process.version,
    operatingSystem: "linux synthetic",
    browserProjects: ["chromium"],
    workers: 1,
    retries: 0,
    tagExpression: "",
    selectionSummary: { matchedCount: tests.length, excludedCount: 0 },
    counts,
    tests,
    nativeReportPath: "../html-report/index.html",
  };
}

const REPRESENTATIVE_TESTS: RunReportTest[] = [
  makeTest({
    testId: "synthetic.initial-pass",
    status: "initial-pass",
    steps: [
      { title: "Arrange", category: "test.step", durationMs: 5, status: "passed" },
      { title: "Assert", category: "test.step", durationMs: 5, status: "passed" },
    ],
    assertionCount: 3,
    whyPassed: "Passed because all 3 recorded assertion(s) across 2 named step(s) succeeded.",
  }),
  makeTest({
    testId: "synthetic.consistent-failure",
    status: "consistent-failure",
    steps: [
      { title: "Arrange", category: "test.step", durationMs: 5, status: "passed" },
      {
        title: "Assert",
        category: "test.step",
        durationMs: 5,
        status: "failed",
        error: "expect(received).toBe(expected)",
      },
    ],
    assertionCount: 2,
    errorMessage: "expect(received).toBe(expected)",
    sanitizedStackTrace: "at synthetic.spec.ts:10:5",
    failureScreenshotPath: "artifacts/playwright/runs/test-results/synthetic/failure.png",
    tracePath: "artifacts/playwright/runs/test-results/synthetic/trace.zip",
    whyFailed: 'Failed during the "Assert" step: expect(received).toBe(expected).',
  }),
  makeTest({
    testId: "synthetic.timeout",
    status: "timeout",
    durationMs: 30000,
    whyFailed: "Did not complete within the configured timeout.",
  }),
  makeTest({
    testId: "synthetic.retry-pass",
    status: "retry-pass",
    attempts: 2,
    steps: [{ title: "Assert", category: "test.step", durationMs: 5, status: "passed" }],
    assertionCount: 1,
    whyPassed: "Passed because all 1 recorded assertion(s) across 1 named step(s) succeeded.",
  }),
  makeTest({
    testId: "synthetic.skipped",
    status: "skipped",
    assertionCount: 0,
    steps: [],
  }),
  makeTest({
    testId: "synthetic.setup-failure",
    status: "setup-failure",
    steps: [],
    assertionCount: 0,
    errorMessage: "browserType.launch: Executable doesn't exist",
    whyFailed:
      "Failed before any of the test's own named steps ran -- most consistent with a fixture, " +
      "hook, or environment problem rather than the test's own assertions (best-effort " +
      "classification, not a certainty).",
  }),
];

test("renders one badge per representative status with the correct label and count", async () => {
  const report = makeReport(REPRESENTATIVE_TESTS);
  const html = renderRunReportHtml(report);
  await page.setContent(html);

  const expectations: Array<{ testId: string; label: string }> = [
    { testId: "synthetic.initial-pass", label: "Passed" },
    { testId: "synthetic.consistent-failure", label: "Failed" },
    { testId: "synthetic.timeout", label: "Timed out" },
    { testId: "synthetic.retry-pass", label: "Passed on retry (flaky)" },
    { testId: "synthetic.skipped", label: "Skipped" },
    { testId: "synthetic.setup-failure", label: "Setup/infrastructure failure" },
  ];

  for (const { testId, label } of expectations) {
    const row = page.locator(`.test-row[data-test-id="${testId}"]`);
    await expect(row, `row for ${testId}`).toHaveCount(1);
    await expect(row.locator(".badge")).toContainText(label);
  }

  // Summary cards reflect the same counts the JSON `counts` object holds -- not just "some text
  // appears somewhere," but the actual per-card count next to its label. Matched by the EXACT
  // label text (not substring) since "Passed" is itself a substring of "Passed on retry (flaky)".
  const summaryCounts: Array<{ label: string; count: number }> = [
    { label: "Passed", count: report.counts.initialPass },
    { label: "Passed on retry (flaky)", count: report.counts.retryPass },
    { label: "Failed", count: report.counts.consistentFailure },
    { label: "Timed out", count: report.counts.timeout },
    { label: "Skipped", count: report.counts.skipped },
    { label: "Setup/infrastructure failure", count: report.counts.setupFailure },
  ];
  for (const { label, count } of summaryCounts) {
    const card = page
      .locator(".summary-card")
      .filter({ has: page.locator(".summary-label", { hasText: exactly(label) }) });
    await expect(card, `summary card for "${label}"`).toHaveCount(1);
    await expect(card.locator(".summary-count")).toHaveText(String(count));
  }

  await expect(page.locator(".test-row")).toHaveCount(REPRESENTATIVE_TESTS.length);
});

test("failure diagnostics (error message, stack trace, screenshot/trace links) render for a failed test", async () => {
  const report = makeReport(REPRESENTATIVE_TESTS);
  const html = renderRunReportHtml(report);
  await page.setContent(html);

  const failedRow = page.locator('.test-row[data-test-id="synthetic.consistent-failure"]');
  // The row's own <summary> only -- not the nested <details><summary>Stack trace</summary></details>
  // further down inside the same row, which also matches a bare "summary" descendant selector.
  await failedRow.locator("> summary").click();
  await expect(failedRow.locator(".error-message")).toContainText("expect(received).toBe(expected)");
  await expect(failedRow.locator(".stack-trace-details summary")).toHaveText("Stack trace");
  await expect(failedRow.getByRole("link", { name: "Failure screenshot" })).toHaveCount(1);
  await expect(failedRow.getByRole("link", { name: "Trace (open with Trace Viewer)" })).toHaveCount(1);
});

test("the client-side search filter really hides non-matching rows and shows matching ones", async () => {
  const report = makeReport(REPRESENTATIVE_TESTS);
  const html = renderRunReportHtml(report);
  await page.setContent(html);

  const search = page.locator("#search");
  await search.fill("timeout");

  await expect(page.locator('.test-row[data-test-id="synthetic.timeout"]')).toBeVisible();
  await expect(page.locator('.test-row[data-test-id="synthetic.initial-pass"]')).toBeHidden();
  await expect(page.locator('.test-row[data-test-id="synthetic.consistent-failure"]')).toBeHidden();

  await search.fill("");
  await expect(page.locator('.test-row[data-test-id="synthetic.initial-pass"]')).toBeVisible();
});

test("renders no runtime errors and shows the empty-state message when a run has zero tests", async () => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  const report = makeReport([]);
  const html = renderRunReportHtml(report);
  await page.setContent(html);

  await expect(page.getByText("No tests were executed in this run.")).toBeVisible();
  await expect(page.locator(".test-row")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Stage 06 AUDIT FINDING (locking regression test): the light-mode status colors (--pass/--fail/
// --warn) were reused verbatim under `@media (prefers-color-scheme: dark)` -- they were chosen for
// contrast against a WHITE background, so against the actual dark background/card background they
// measured ~2.4-3.1:1, well under WCAG AA's 4.5:1 minimum for this text size (Section 10.1:
// "sufficient contrast"). Verified live in a real Chromium page with `colorScheme: "dark"` before
// fixing dark-mode-specific color values. A future change to any of --pass/--fail/--warn (light OR
// dark) must keep this passing, not just look right to a reviewer's eye in one color scheme.
function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const l1 = relativeLuminance(...rgb1);
  const l2 = relativeLuminance(...rgb2);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`Could not parse CSS color: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

test("status badge colors meet WCAG AA contrast (4.5:1) against the page and card backgrounds in both light and dark mode", async () => {
  const report = makeReport(REPRESENTATIVE_TESTS);
  const html = renderRunReportHtml(report);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setContent(html);

    const bodyBg = parseRgb(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
    const cardBg = parseRgb(
      await page.locator(".summary-card").first().evaluate((el) => getComputedStyle(el).backgroundColor),
    );

    const badgeSelectors = [
      ".badge-initial-pass",
      ".badge-consistent-failure",
      ".badge-timeout",
      ".badge-skipped",
      ".badge-setup-failure",
    ];
    for (const selector of badgeSelectors) {
      const badge = page.locator(selector).first();
      await expect(badge, `${selector} in ${colorScheme} mode`).toHaveCount(1);
      const color = parseRgb(await badge.evaluate((el) => getComputedStyle(el).color));
      const ratioVsBody = contrastRatio(color, bodyBg);
      const ratioVsCard = contrastRatio(color, cardBg);
      expect(ratioVsBody, `${selector} vs body background in ${colorScheme} mode`).toBeGreaterThanOrEqual(4.5);
      expect(ratioVsCard, `${selector} vs card background in ${colorScheme} mode`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
