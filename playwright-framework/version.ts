/**
 * Stage 07 — a single source of truth for the "framework version" Section 10.1 (run reports) and
 * Section 10.3 (suite reviews) both ask reports to disclose, distinct from Playwright's own version
 * (already recorded separately, e.g. `RunReport.playwrightVersion`). This repo's root package.json
 * carries no version field of its own (DEC-023, not a gap this module invents an answer to), so
 * this constant tracks the highest PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md stage completed and
 * audited so far -- bump it in the same commit that closes out a stage's audit.
 */
export const FRAMEWORK_VERSION = "0.10.0"; // Stage 10: CI, documentation, adoption, and operational hardening
