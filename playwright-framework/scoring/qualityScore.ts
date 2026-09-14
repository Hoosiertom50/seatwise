import type { TestValueModelFile } from "../metadata/schemas.js";
import type { CriterionJudgment, ScoreResult } from "./types.js";
import { computeScore } from "./computeScore.js";

/** Computes a test's quality score (Section 8.5) from criterion judgments and the canonical
 * model. No band is attached — the spec defines bands only for value scores (Section 8.4). */
export function computeQualityScore(
  model: TestValueModelFile,
  judgments: CriterionJudgment[],
): ScoreResult {
  return computeScore({
    modelVersion: model.modelVersion,
    criteria: model.qualityCriteria,
    judgments,
  });
}
