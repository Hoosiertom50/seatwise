/**
 * Stage 02 — cross-cutting metadata validation: unique test IDs, tests referencing requirement
 * IDs that actually exist (or explicitly declaring none, which is flagged for human review rather
 * than silently accepted), tag-rule compliance (via tagValidation.ts), and non-empty objectives /
 * expected outcomes. This is what "invalid or contradictory metadata fails before execution" means
 * in practice: run this against the full set of authored test metadata and a non-empty result means
 * the run must not proceed.
 *
 * Stage 04 addition: a requirementIds entry pointing at a requirement whose own `status` is
 * "retired" is flagged as stale metadata (spec Stage 04 task: "Add checks for unknown tags,
 * duplicate IDs, missing mappings, and stale metadata") -- the requirement ID still resolves (so
 * the pre-existing "unknown requirement" check wouldn't catch it), but the test is citing a
 * requirement the business has since withdrawn, which is exactly the kind of drift that check is
 * meant to close.
 */

import type { RequirementsFile, TagTaxonomyFile, TestMetadata } from "./schemas.js";
import { validateTags } from "./tagValidation.js";

export interface MetadataValidationIssue {
  testId: string;
  message: string;
  /** True when this is a soft flag for a human, not a hard validation failure (Section 8.6:
   * "Missing business information must be marked NEEDS HUMAN REVIEW; the AI must not invent
   * impact or regulatory importance."). Soft flags do not fail validation on their own. */
  needsHumanReview: boolean;
}

export interface MetadataValidationSummary {
  /** True only when there are zero hard-failure issues. Human-review flags do not block. */
  valid: boolean;
  issues: MetadataValidationIssue[];
}

export function validateAllTestMetadata(
  tests: TestMetadata[],
  taxonomy: TagTaxonomyFile,
  requirements: RequirementsFile,
): MetadataValidationSummary {
  const issues: MetadataValidationIssue[] = [];
  const requirementIds = new Set(requirements.requirements.map((r) => r.id));
  const retiredRequirementIds = new Set(
    requirements.requirements.filter((r) => r.status === "retired").map((r) => r.id),
  );
  const seenIds = new Map<string, number>();

  for (const test of tests) {
    seenIds.set(test.id, (seenIds.get(test.id) ?? 0) + 1);

    if (!test.objective.trim()) {
      issues.push({ testId: test.id, message: "objective must not be empty", needsHumanReview: false });
    }
    if (!test.expectedOutcome.trim()) {
      issues.push({
        testId: test.id,
        message: "expectedOutcome must not be empty",
        needsHumanReview: false,
      });
    }

    if (test.requirementIds.length === 0) {
      issues.push({
        testId: test.id,
        message: "no requirementIds mapped — value scoring cannot cite a driving requirement",
        needsHumanReview: true,
      });
    } else {
      for (const reqId of test.requirementIds) {
        if (!requirementIds.has(reqId)) {
          issues.push({
            testId: test.id,
            message: `requirementIds references unknown requirement "${reqId}"`,
            needsHumanReview: false,
          });
        } else if (retiredRequirementIds.has(reqId)) {
          issues.push({
            testId: test.id,
            message: `requirementIds references retired requirement "${reqId}" -- stale metadata: re-map this test to a current requirement or retire the test too`,
            needsHumanReview: false,
          });
        }
      }
    }

    const tagResult = validateTags(test.tags, taxonomy);
    for (const error of tagResult.errors) {
      issues.push({ testId: test.id, message: error, needsHumanReview: false });
    }
  }

  for (const [id, count] of seenIds) {
    if (count > 1) {
      issues.push({
        testId: id,
        message: `duplicate test id "${id}" used ${count} times — test IDs must be unique`,
        needsHumanReview: false,
      });
    }
  }

  const valid = issues.every((issue) => issue.needsHumanReview);
  return { valid, issues };
}
