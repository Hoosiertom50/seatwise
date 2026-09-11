// Stage 01: Playwright Test configuration. Environment-driven, safe by default, and scoped so it
// never picks up apps/mobile/__tests__ (unrelated Vitest/Jest-style unit tests -- see the spec's
// Project Profile and Decision Log for why those are left untouched).
import { defineConfig, devices } from "@playwright/test";
import { getEnv } from "./e2e/support/env";

const env = getEnv();

// Sandbox-only workaround: this cloud dev environment pre-installs a Chromium build that doesn't
// always match the exact revision @playwright/test expects, and has no network access to fetch a
// replacement. Setting PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points Playwright at that pre-installed
// binary instead. Leave this unset anywhere Playwright's own browser install has been run normally
// (e.g. `pnpm exec playwright install chromium` on a developer's machine or in CI) -- it is `undefined`
// there, and Playwright falls back to its own default resolution exactly as documented upstream.
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  // Fails the run (rather than silently passing) if a `.only` was left in by accident.
  forbidOnly: !!env.CI,

  // Local diagnosis uses zero retries; CI retries once and a retry-pass gets labeled flaky by the
  // reporter built in Stage 06.
  retries: env.CI ? 1 : 0,
  workers: env.CI ? 2 : undefined,

  // Stage 10: explicit, CI-appropriate timeouts rather than relying on Playwright's bare defaults
  // (30s per test, no global ceiling). A per-test timeout that's too tight for a shared CI runner
  // would turn ordinary machine slowness into false "consistent-failure"/"timeout" classifications;
  // a global ceiling exists so a genuinely hung run (e.g. a wedged dev server) fails the CI job
  // outright rather than running until the platform's own job-level timeout silently kills it with
  // no normalized report ever written. Local runs keep Playwright's un-ceilinged default so a
  // developer attached to a debugger is never cut off.
  timeout: env.CI ? 45_000 : 30_000,
  expect: { timeout: env.CI ? 10_000 : 5_000 },
  globalTimeout: env.CI ? 10 * 60_000 : undefined,

  // Blocks any browser project from launching before this runs -- see e2e/support/globalSetup.ts
  // for what it actually checks (the production/mutation guard).
  globalSetup: "./e2e/support/globalSetup.ts",

  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/playwright/runs/html-report", open: "never" }],
    // Stage 06: a normalized, schema-validated JSON + self-contained HTML companion report
    // (playwright-framework/reporting/normalizedReporter.ts) alongside Playwright's own native
    // ones above -- see PLAYWRIGHT_TESTING.md's "Test-run reports" section.
    ["./playwright-framework/reporting/normalizedReporter.ts"],
  ],
  outputDir: "artifacts/playwright/runs/test-results",

  use: {
    baseURL: env.APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off", // deferred: revisit once Stage 03's evidence architecture is in place
  },

  projects: [
    // Framework self-tests (env config, production guard, and more added in later stages). No
    // browser needed -- these are plain TypeScript unit tests run through Playwright Test.
    {
      name: "framework-unit",
      testDir: "./playwright-framework/tests",
    },

    // Application E2E tests. Chromium is the required baseline browser (spec Section 5 defaults).
    {
      name: "chromium",
      testDir: "./e2e/tests",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {},
      },
    },

    // Firefox/WebKit stay defined-but-unused for now (DEC-003): no known cross-browser requirement
    // or defect history yet. Run explicitly with `pnpm exec playwright test --project=firefox` (or
    // webkit) when that changes -- `pnpm pw:test` only runs the chromium + framework-unit projects.
    {
      name: "firefox",
      testDir: "./e2e/tests",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testDir: "./e2e/tests",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
