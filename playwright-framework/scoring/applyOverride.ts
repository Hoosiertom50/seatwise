/**
 * Stage 02 — applies a human override (quality/value-overrides.yaml) on top of a calculated
 * ScoreResult. This is the mechanism behind "reports can distinguish calculated, provisional, and
 * human-overridden scores" (Stage 02 acceptance criterion): overriding never mutates or hides the
 * calculated result, it returns a new ScoreResult with `source: "override"` and an `overrideRef`
 * carrying the rationale/approver/date, alongside the original criteria breakdown for comparison.
 */

import type { ValueOverride } from "../metadata/schemas.js";
import type { ScoreResult } from "./types.js";

export function applyOverride(
  calculated: ScoreResult,
  override: ValueOverride,
  /** Recomputes the band for the new total. Omit for quality scores, which are never banded. */
  bandFn?: (total: number) => string,
): ScoreResult {
  if (override.overrideType === "total-score") {
    return {
      ...calculated,
      total: override.value,
      band: bandFn ? bandFn(override.value) : calculated.band,
      source: "override",
      provisional: false,
      overrideRef: {
        testId: override.testId,
        rationale: override.rationale,
        approver: override.approver,
        date: override.date,
      },
    };
  }

  // criterion-score override: replace just that criterion's contribution, then re-sum.
  const criterionId = override.criterionId;
  if (!criterionId) {
    throw new Error("criterion-score override missing criterionId");
  }
  const criterionIndex = calculated.criteria.findIndex((c) => c.criterionId === criterionId);
  if (criterionIndex === -1) {
    throw new Error(
      `override references unknown criterion "${criterionId}" for test "${override.testId}"`,
    );
  }
  const criterion = calculated.criteria[criterionIndex];
  if (override.value > criterion.weight) {
    throw new Error(
      `override value ${override.value} exceeds criterion "${criterionId}"'s max weight ${criterion.weight}`,
    );
  }

  const updatedCriteria = calculated.criteria.map((c, i) =>
    i === criterionIndex
      ? { ...c, points: override.value, needsHumanReview: false, rationale: override.rationale }
      : c,
  );
  const total = updatedCriteria.reduce((sum, c) => sum + c.points, 0);

  return {
    ...calculated,
    criteria: updatedCriteria,
    total,
    band: bandFn ? bandFn(total) : calculated.band,
    source: "override",
    provisional: updatedCriteria.some((c) => c.needsHumanReview),
    overrideRef: {
      testId: override.testId,
      rationale: override.rationale,
      approver: override.approver,
      date: override.date,
    },
  };
}
