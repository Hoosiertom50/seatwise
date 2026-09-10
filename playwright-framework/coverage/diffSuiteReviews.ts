/**
 * Stage 07 — Section 10.3's "changes from the previous review, when a prior machine-readable
 * report exists". Pure diff over two already-loaded/validated `SuiteReview` documents: which tests
 * were added or removed since the last review, and which tests' value/quality totals changed.
 * Deliberately reports every changed total, however small -- rounding or suppressing "insignificant"
 * changes would be an invented judgment call this module has no basis for; a human reading the
 * suite-review report decides what change size warrants attention, not this function.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SuiteReview, SuiteReviewChange } from "../metadata/schemas.js";

/** `undefined` when there is no previous review to diff against -- the caller's `changesFrom
 * PreviousReview` field is `optional()` in `SuiteReviewSchema` for exactly this reason (Section
 * 10.3 says the field only appears "when a prior machine-readable report exists"). */
export function diffSuiteReviews(
  previous: SuiteReview | undefined,
  current: Pick<SuiteReview, "reviewId" | "generatedAt" | "tests">,
): SuiteReviewChange | undefined {
  if (!previous) return undefined;

  const previousById = new Map(previous.tests.map((t) => [t.testId, t]));
  const currentById = new Map(current.tests.map((t) => [t.testId, t]));

  const addedTestIds = [...currentById.keys()].filter((id) => !previousById.has(id)).sort();
  const removedTestIds = [...previousById.keys()].filter((id) => !currentById.has(id)).sort();

  const valueScoreChanges: { testId: string; previousTotal: number; currentTotal: number }[] = [];
  const qualityScoreChanges: { testId: string; previousTotal: number; currentTotal: number }[] = [];

  for (const [testId, currentTest] of currentById) {
    const previousTest = previousById.get(testId);
    if (!previousTest) continue; // newly added -- nothing to compare against
    if (previousTest.valueScore.total !== currentTest.valueScore.total) {
      valueScoreChanges.push({
        testId,
        previousTotal: previousTest.valueScore.total,
        currentTotal: currentTest.valueScore.total,
      });
    }
    if (previousTest.qualityScore.total !== currentTest.qualityScore.total) {
      qualityScoreChanges.push({
        testId,
        previousTotal: previousTest.qualityScore.total,
        currentTotal: currentTest.qualityScore.total,
      });
    }
  }

  valueScoreChanges.sort((a, b) => a.testId.localeCompare(b.testId));
  qualityScoreChanges.sort((a, b) => a.testId.localeCompare(b.testId));

  return {
    previousReviewId: previous.reviewId,
    previousGeneratedAt: previous.generatedAt,
    addedTestIds,
    removedTestIds,
    valueScoreChanges,
    qualityScoreChanges,
  };
}

/** Finds the most recently modified prior suite-review JSON file in `suiteReviewsDir`, if any --
 * the caller (the CLI) reads and validates the file itself; this function only picks which file to
 * read, tolerating a directory that does not exist yet exactly like `runReportHistory.ts` does for
 * run reports (an empty/missing directory is a normal "no prior review" state, not an error). */
export function findMostRecentSuiteReviewPath(suiteReviewsDir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(suiteReviewsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;
  const withMtime = entries
    .map((f) => ({ f, mtime: statSync(join(suiteReviewsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return join(suiteReviewsDir, withMtime[0].f);
}
