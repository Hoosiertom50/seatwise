/**
 * Stage 02 — shared deterministic scoring arithmetic used by both valueScore.ts and
 * qualityScore.ts. Given a model's criteria (id/label/weight) and a set of per-criterion
 * judgments, produces a ScoreResult. Pure function: no I/O, no randomness, no AI calls — the
 * judgments themselves are the only input that carries any judgment.
 */

import type { ModelCriterion } from "../metadata/schemas.js";
import type { CriterionJudgment, CriterionResult, ScoreResult } from "./types.js";

export interface ComputeScoreOptions {
  modelVersion: string;
  criteria: ModelCriterion[];
  judgments: CriterionJudgment[];
  /** Included only for value scores (Section 8.4); omit for quality scores. */
  band?: (total: number) => string;
}

export function computeScore(options: ComputeScoreOptions): ScoreResult {
  const { modelVersion, criteria, judgments, band } = options;

  const judgmentById = new Map(judgments.map((j) => [j.criterionId, j]));
  const knownIds = new Set(criteria.map((c) => c.id));

  for (const judgment of judgments) {
    if (!knownIds.has(judgment.criterionId)) {
      throw new Error(
        `judgment references unknown criterion "${judgment.criterionId}" — not defined in this model version (${modelVersion})`,
      );
    }
  }

  const criteriaResults: CriterionResult[] = criteria.map((criterion) => {
    const judgment = judgmentById.get(criterion.id);
    if (!judgment) {
      // A criterion with no judgment at all is treated identically to one explicitly flagged
      // needsHumanReview: missing information must never be silently scored as zero-and-final.
      return {
        criterionId: criterion.id,
        label: criterion.label,
        weight: criterion.weight,
        points: 0,
        rationale: "no judgment provided for this criterion",
        confidence: "low",
        needsHumanReview: true,
      };
    }

    if (judgment.needsHumanReview || judgment.points === undefined) {
      return {
        criterionId: criterion.id,
        label: criterion.label,
        weight: criterion.weight,
        points: 0,
        rationale: judgment.rationale,
        confidence: judgment.confidence,
        needsHumanReview: true,
      };
    }

    if (judgment.points < 0 || judgment.points > criterion.weight) {
      throw new Error(
        `criterion "${criterion.id}" judged ${judgment.points} points, outside its allowed range 0..${criterion.weight}`,
      );
    }

    return {
      criterionId: criterion.id,
      label: criterion.label,
      weight: criterion.weight,
      points: judgment.points,
      rationale: judgment.rationale,
      confidence: judgment.confidence,
      needsHumanReview: false,
    };
  });

  const total = criteriaResults.reduce((sum, c) => sum + c.points, 0);
  const provisional = criteriaResults.some((c) => c.needsHumanReview);

  return {
    modelVersion,
    total,
    band: band ? band(total) : undefined,
    // "provisional" is a real, reachable source (not just the separate `provisional` boolean):
    // a score computed on an incomplete evidence set is reported as provisional, not silently as
    // a fully-calculated one. See stage-02-audit.md's Medium finding for why this distinction
    // matters once a report renderer starts keying off `source` directly.
    source: provisional ? "provisional" : "calculated",
    criteria: criteriaResults,
    provisional,
  };
}
