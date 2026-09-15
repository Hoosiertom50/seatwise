/**
 * TS-53 (REQ-NON-FUNCTIONAL) — shared axe-core scan helper, used by every accessibility test so
 * the WCAG rule-set selection and violation-reporting format live in exactly one place rather
 * than being copy-pasted per test file.
 *
 * Rule-set choice: `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` is axe-core's own documented tag
 * combination for "WCAG 2.1 Level AA" (2.1 AA is a strict superset of 2.0 AA — the 2.0 tags catch
 * the criteria unchanged since 2.0, the 2.1 tags catch the criteria 2.1 added), matching both
 * AC-079's own wording ("The app conforms to WCAG 2.1 Level AA") and README.md's prior manual
 * exercise (NFR-9.5, "scanned with axe-core against the WCAG 2.1 A/AA ... rule sets").
 *
 * `best-practice` is deliberately NOT included -- those are axe's own opinionated recommendations
 * beyond what WCAG itself requires, and including them would fail this suite on things that are
 * not actually AC-079 violations.
 */

import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const WCAG_21_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

export interface AxeScanResult {
  violationCount: number;
  /** A human-readable, newline-joined summary of every violation (rule id, impact, description,
   * and the CSS selector of each affected node) -- empty string when violationCount is 0. Meant
   * to be interpolated into an assertion's own failure message so a red run names the actual rule
   * and element, not just "expected 0 to be greater than 0". */
  summary: string;
}

/** Runs an axe-core scan of the page's current DOM against the WCAG 2.1 Level AA rule set. Does
 * not assert anything itself -- callers decide how to report a non-zero result (see
 * `e2e/tests/accessibility.*.spec.ts` for the established pattern: `expect(result.violationCount,
 * result.summary).toBe(0)`). */
export async function scanForWcagAaViolations(page: Page): Promise<AxeScanResult> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_21_AA_TAGS).analyze();
  const summary = results.violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => node.target.join(" ")).join(", ");
      return `[${violation.impact ?? "unknown"}] ${violation.id}: ${violation.description} -- ${violation.nodes.length} node(s): ${targets}`;
    })
    .join("\n");
  return { violationCount: results.violations.length, summary };
}
