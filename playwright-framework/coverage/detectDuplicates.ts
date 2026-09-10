/**
 * Stage 07 — likely-duplicate / substantially-overlapping test detection (Section 10.3 task:
 * "Detect likely duplicates and label them as recommendations, not automatic deletions"). This
 * module only ever returns candidates for a HUMAN to look at -- nothing here deletes, disables, or
 * quarantines a test, and every candidate carries the concrete evidence (shared requirements,
 * shared tags, objective-text similarity) a reviewer needs to judge it themselves.
 *
 * Two tests are flagged only when they plausibly protect the SAME behavior: same requirement(s),
 * same feature area, AND same data-impact (@readonly vs @mutating) -- two tests sharing a
 * requirement but with different data-impact tags are validating different actions against that
 * requirement (e.g. "view an existing guest" vs "add a new guest" both cite
 * REQ-GUEST-LIST-MANAGEMENT) and must never be flagged as duplicates on requirement-overlap alone.
 * Within that group, objective-text similarity (word-overlap Jaccard) is the tie-breaker signal
 * that actually distinguishes "these validate the same thing" from "these happen to share tags."
 */

import type { DuplicateCandidate } from "../metadata/schemas.js";

export interface DuplicateDetectionTestInput {
  testId: string;
  tags: string[];
  requirementIds: string[];
  objective: string;
}

const FEATURE_TAG_PREFIX = "@feature:";
const DATA_IMPACT_TAGS = new Set(["@readonly", "@mutating"]);

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2), // drop tiny stopword-ish tokens ("a", "to", "an", ...)
  );
}

/** Jaccard similarity (intersection / union) between two objectives' word sets -- 0 if either is
 * empty, 1 if identical word sets. A simple, transparent, dependency-free heuristic: this is a
 * human-review SIGNAL (see module doc), not a claim of semantic understanding. */
export function objectiveSimilarity(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const word of setA) if (setB.has(word)) intersectionSize++;
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/** Minimum objective-word-overlap before a same-requirement/same-feature/same-data-impact pair is
 * actually flagged, rather than merely noted -- chosen so two tests that legitimately validate the
 * same requirement via genuinely different, differently-worded scenarios are not flagged on tag
 * overlap alone. Documented, not tuned against a large corpus (only 2 real tests exist as of
 * Stage 07) -- a future stage with more tests may need to revisit this threshold. */
const SIMILARITY_THRESHOLD = 0.5;

export function detectDuplicates(tests: DuplicateDetectionTestInput[]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  for (let i = 0; i < tests.length; i++) {
    for (let j = i + 1; j < tests.length; j++) {
      const a = tests[i];
      const b = tests[j];

      const sharedRequirementIds = a.requirementIds.filter((id) => b.requirementIds.includes(id));
      if (sharedRequirementIds.length === 0) continue;

      const aDataImpact = a.tags.find((t) => DATA_IMPACT_TAGS.has(t));
      const bDataImpact = b.tags.find((t) => DATA_IMPACT_TAGS.has(t));
      if (!aDataImpact || !bDataImpact || aDataImpact !== bDataImpact) continue; // different action shape

      const sharedFeatureTags = a.tags.filter(
        (t) => t.startsWith(FEATURE_TAG_PREFIX) && b.tags.includes(t),
      );
      if (sharedFeatureTags.length === 0) continue;

      const similarity = objectiveSimilarity(a.objective, b.objective);
      if (similarity < SIMILARITY_THRESHOLD) continue;

      const sharedTags = a.tags.filter((t) => b.tags.includes(t));
      candidates.push({
        testIds: [a.testId, b.testId],
        sharedRequirementIds,
        sharedTags,
        objectiveSimilarity: similarity,
        rationale:
          `Both tests share requirement(s) ${sharedRequirementIds.join(", ")}, the same data-impact ` +
          `tag (${aDataImpact}), feature tag(s) ${sharedFeatureTags.join(", ")}, and their objectives ` +
          `overlap ${Math.round(similarity * 100)}% by word content -- worth a human look to confirm ` +
          `whether one materially adds unique coverage or can be retired (never auto-deleted).`,
      });
    }
  }

  return candidates;
}
