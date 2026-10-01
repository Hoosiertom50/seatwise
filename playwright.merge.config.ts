// TS-139: config for `playwright merge-reports` in CI only. The chromium/firefox/webkit shards run
// inside Playwright's container (checkout at /__w/...) and Edge on the plain runner
// (/home/runner/work/...), so their blob reports carry different absolute test directories and
// merge-reports refuses to combine them without a shared testDir. Every application e2e project's
// testDir is ./e2e/tests (see playwright.config.ts).
export default {
  testDir: "./e2e/tests",
};
