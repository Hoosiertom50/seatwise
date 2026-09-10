/**
 * Stage 02 — the structured interface an AI evaluator (or a human) uses to report per-criterion
 * evidence, and the shape a computed score takes. Kept separate from the deterministic arithmetic
 * in valueScore.ts/qualityScore.ts: judgment (what points a criterion earns, and why) is a
 * separate, inspectable input; turning a set of judgments into a total/band is pure math with no
 * judgment calls of its own (Section 8.6: "Scoring arithmetic must be deterministic").
 */

export type Confidence = "high" | "medium" | "low";

/**
 * One criterion's judged score, prior to arithmetic. `points` is 0..criterion.weight (i.e. already
 * scaled to that criterion's weight, not a raw 0-100 percentage) so summing `points` across all
 * criteria directly yields the total — no further scaling step to get wrong.
 */
export interface CriterionJudgment {
  criterionId: string;
  /** 0..weight. Absent (undefined) means "not yet judged" — see `needsHumanReview` below. */
  points: number | undefined;
  rationale: string;
  confidence: Confidence;
  /** Set true when the evaluator (AI or human) lacks the business/domain information needed to
   * judge this criterion honestly. Per Section 8.6, the evaluator must flag this rather than
   * invent an impact or regulatory judgment. A criterion flagged here contributes 0 to the total
   * and forces the whole score's `provisional` flag on. */
  needsHumanReview: boolean;
}

export type ScoreSource = "calculated" | "override" | "provisional";

export interface CriterionResult {
  criterionId: string;
  label: string;
  weight: number;
  points: number;
  rationale: string;
  confidence: Confidence;
  needsHumanReview: boolean;
}

export interface ScoreResult {
  modelVersion: string;
  total: number;
  /** Value scores carry a band (Section 8.4); quality scores do not — the spec defines bands only
   * for the value model, so this is omitted there rather than invented. */
  band?: string;
  source: ScoreSource;
  criteria: CriterionResult[];
  /** True when any criterion is flagged needsHumanReview (Section 8.6: reports must distinguish
   * calculated, provisional, and human-overridden scores — provisional means "computed, but on an
   * incomplete evidence set"). */
  provisional: boolean;
  overrideRef?: {
    testId: string;
    rationale: string;
    approver: string;
    date: string;
  };
}
