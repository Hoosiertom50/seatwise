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

// TS-58 follow-up (found live while verifying pw:test:slow): `playwright test` has no `--slow-mo`
// CLI flag at all -- that flag only exists on `playwright open`/`codegen`, and passing it to `test`
// fails immediately with "error: unknown option '--slow-mo=800'" before a single test runs. The only
// way to get slow-motion into a `playwright test` run is through config, via
// `use.launchOptions.slowMo`. PW_SLOW_MO is read here so `pnpm pw:test:slow` can opt into it without
// a second config file; unset (the normal case for every other script), this is `undefined` and
// launchOptions carries no slowMo key at all, identical to today's behavior.
const slowMoMs = process.env.PW_SLOW_MO ? Number(process.env.PW_SLOW_MO) : undefined;

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
  //
  // TS-58 follow-up, found live while verifying pw:test:slow with real slowMo finally working: the
  // suite's two most action-heavy tests (the responsive-layout a11y test's 3-viewport sweep, and the
  // drag-a-guest-between-tables test's 4 full drag sequences) run 30+ discrete Playwright actions.
  // With slowMoMs set, each of those actions now genuinely waits slowMoMs before proceeding, so those
  // two tests alone can exceed the plain local 30s budget on their action count before any real page
  // work even happens -- confirmed by direct reproduction ("Test timeout of 30000ms exceeded."), not
  // guessed. This never mattered before because --slow-mo silently failed to apply at all (see the
  // slowMoMs comment above). CI never sets PW_SLOW_MO, so env.CI's 45_000 is completely unaffected;
  // this only widens the *local, opt-in, developer-driven* debugging path.
  timeout: env.CI ? 45_000 : slowMoMs ? 120_000 : 30_000,
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
        launchOptions: {
          ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
          ...(slowMoMs ? { slowMo: slowMoMs } : {}),
        },
      },
    },

    // Firefox (TS-61) and WebKit (TS-62) both now run independently in the real, blocking CI gate
    // (the e2e-firefox and e2e-webkit jobs in .github/workflows/ci.yml), superseding DEC-003's
    // original "no known cross-browser requirement yet" -- see DEC-035/DEC-036 in
    // PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md's Decision Log. `pnpm pw:test` itself is unchanged and
    // still only runs the chromium + framework-unit projects locally; run either of these directly
    // with `pnpm exec playwright test --project=firefox` (or webkit) for a local cross-browser check.
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

    // TS-63 SPIKE (DO NOT MERGE): Edge isn't a separate rendering engine the way Firefox/WebKit are
    // -- Playwright runs it via a "channel" on top of the same Chromium engine the chromium project
    // above already uses (still chromium.launch() under the hood). `devices["Desktop Edge"]` alone
    // only sets an Edge-flavored user agent/viewport; `channel: "msedge"` is what actually launches
    // real Microsoft Edge instead of chromium pretending to be it -- Playwright's own documented
    // pattern for this. GitHub's ubuntu-latest runners ship Edge preinstalled, so this needs no new
    // browser-binary download the way Firefox/WebKit did (see TS-63's own Jira ticket).
    {
      name: "edge",
      testDir: "./e2e/tests",
      use: { ...devices["Desktop Edge"], channel: "msedge" },
    },
  ],
});
