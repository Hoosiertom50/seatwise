import type { TestValueModelFile } from "../metadata/schemas.js";
import type { CriterionJudgment, ScoreResult } from "./types.js";
import { computeScore } from "./computeScore.js";
import { bandForValueScore } from "./bands.js";

/** Computes a test's value score (Section 8.3/8.4) from criterion judgments and the canonical
 * value model. Never call this with pass/fail information — value is deliberately independent of
 * current test execution status (Section 8.1). */
export function computeValueScore(
  model: TestValueModelFile,
  judgments: CriterionJudgment[],
): ScoreResult {
  return computeScore({
    modelVersion: model.modelVersion,
    criteria: model.valueCriteria,
    judgments,
    band: (total) => bandForValueScore(total, model),
  });
}
