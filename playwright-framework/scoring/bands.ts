/**
 * Stage 02 — maps a total value score (0-100) to its band per Section 8.4. Quality scores are
 * intentionally not banded: the spec only defines bands for the value model (Section 8.4's table
 * is titled "Value bands"); inventing an equivalent quality-band table would be adding a judgment
 * the spec never asked for.
 */

import type { TestValueModelFile } from "../metadata/schemas.js";

export function bandForValueScore(score: number, model: TestValueModelFile): string {
  const band = model.valueBands.find((b) => score >= b.minScore && score <= b.maxScore);
  if (!band) {
    throw new Error(
      `no value band covers score ${score} — valueBands in the model must cover the full 0-100 range`,
    );
  }
  return band.band;
}
