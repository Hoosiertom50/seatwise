/**
 * Stage 02 — canonical, versioned schemas for the quality governance data files.
 *
 * Per DEC-008 (see PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md Decision Log), these zod schemas ARE
 * the versioned schema artifact the spec calls for (Section "Stage 02 — Tasks": "Create versioned
 * schemas for requirements, tag taxonomy, value model, overrides, test inventory, run results, and
 * maintenance results."). We do not additionally maintain a parallel JSON Schema copy: this repo's
 * existing convention (e2e/support/env.ts) already validates configuration with zod, and a second,
 * hand-synced schema format would only be a second place to drift out of date. Every YAML data file
 * under quality/ is validated against exactly one of these schemas at load time (see loaders.ts),
 * and schema version numbers are recorded via each schema's own `schemaVersion` literal field so a
 * breaking change to a schema is itself a versioned, detectable event.
 *
 * `RunResultSchema` and `MaintenanceResultSchema` describe the shape later stages will produce
 * (Stage 06+ builds the runner/reporters that populate them) — Stage 02 defines and unit-tests the
 * contract now, per the ticket's explicit ask, so later stages consume a stable shape rather than
 * inventing one under deadline.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** ISO-8601 calendar date, e.g. "2026-09-10". Kept as a plain string (not Date) so YAML/JSON
 * round-trips losslessly and diffs stay human-readable. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO-8601 date (YYYY-MM-DD)");

export const NonEmptyStringSchema = z.string().trim().min(1, "must not be empty");

// ---------------------------------------------------------------------------
// Requirements (quality/requirements.yaml)
// ---------------------------------------------------------------------------

export const RequirementStatusSchema = z.enum([
  "placeholder",
  "needs-human-review",
  "confirmed",
  "retired",
]);

export const RequirementSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  /** e.g. "TS-7", "FR-4.3" — free text, may reference multiple external trackers. */
  sourceRefs: z.array(NonEmptyStringSchema).default([]),
  status: RequirementStatusSchema,
  /** Where this requirement's text came from, so a reader can tell "the human wrote this" apart
   * from "seeded from README/other docs and awaiting confirmation". Never invented by the agent. */
  provenance: NonEmptyStringSchema,
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const RequirementsFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  requirements: z.array(RequirementSchema),
});
export type RequirementsFile = z.infer<typeof RequirementsFileSchema>;

// ---------------------------------------------------------------------------
// Tag taxonomy (quality/tag-taxonomy.yaml)
// ---------------------------------------------------------------------------

export const TagDefinitionSchema = z.object({
  name: NonEmptyStringSchema, // e.g. "@readonly"
  description: NonEmptyStringSchema,
  /** Marks a tag as eligible to run against a configured production environment (Section 9.3). */
  productionEligible: z.boolean(),
});
export type TagDefinition = z.infer<typeof TagDefinitionSchema>;

export const TagDimensionSchema = z.object({
  name: NonEmptyStringSchema, // e.g. "data-impact"
  description: NonEmptyStringSchema,
  /** "exactly-one" | "at-least-one" | "optional" */
  requirement: z.enum(["exactly-one", "at-least-one", "optional"]),
  tags: z.array(TagDefinitionSchema).min(1),
});
export type TagDimension = z.infer<typeof TagDimensionSchema>;

export const TagConflictSchema = z.object({
  tags: z.array(NonEmptyStringSchema).min(2),
  reason: NonEmptyStringSchema,
});

export const TagAliasSchema = z.object({
  alias: NonEmptyStringSchema,
  canonical: NonEmptyStringSchema,
});

export const TagTaxonomyFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  changeHistory: z
    .array(
      z.object({
        date: IsoDateSchema,
        change: NonEmptyStringSchema,
      }),
    )
    .min(1),
  dimensions: z.array(TagDimensionSchema).min(1),
  conflicts: z.array(TagConflictSchema).default([]),
  aliases: z.array(TagAliasSchema).default([]),
});
export type TagTaxonomyFile = z.infer<typeof TagTaxonomyFileSchema>;

// ---------------------------------------------------------------------------
// Value / quality model (quality/test-value-model.yaml -> .md)
// ---------------------------------------------------------------------------

/** A criterion's scoring anchors at 0/25/50/75/100% of its own weight (Section 8.3/8.5). */
export const ScoringAnchorsSchema = z.object({
  "0": NonEmptyStringSchema,
  "25": NonEmptyStringSchema,
  "50": NonEmptyStringSchema,
  "75": NonEmptyStringSchema,
  "100": NonEmptyStringSchema,
});
export type ScoringAnchors = z.infer<typeof ScoringAnchorsSchema>;

export const ModelCriterionSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  weight: z.number().int().positive(),
  question: NonEmptyStringSchema,
  anchors: ScoringAnchorsSchema,
  example: NonEmptyStringSchema,
});
export type ModelCriterion = z.infer<typeof ModelCriterionSchema>;

export const ValueBandSchema = z.object({
  band: NonEmptyStringSchema,
  minScore: z.number().min(0).max(100),
  maxScore: z.number().min(0).max(100),
  meaning: NonEmptyStringSchema,
});

export const ChangeHistoryEntrySchema = z.object({
  date: IsoDateSchema,
  modelVersion: NonEmptyStringSchema,
  change: NonEmptyStringSchema,
});

function assertWeightsTotal100(criteria: { weight: number }[], ctx: z.RefinementCtx, path: string) {
  const total = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (total !== 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${path} weights must total exactly 100, got ${total}`,
      path: [path],
    });
  }
}

export const TestValueModelFileSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    modelVersion: NonEmptyStringSchema,
    effectiveDate: IsoDateSchema,
    changeHistory: z.array(ChangeHistoryEntrySchema).min(1),
    valueCriteria: z.array(ModelCriterionSchema).min(1),
    valueBands: z.array(ValueBandSchema).min(1),
    qualityCriteria: z.array(ModelCriterionSchema).min(1),
  })
  .superRefine((model, ctx) => {
    assertWeightsTotal100(model.valueCriteria, ctx, "valueCriteria");
    assertWeightsTotal100(model.qualityCriteria, ctx, "qualityCriteria");
  });
export type TestValueModelFile = z.infer<typeof TestValueModelFileSchema>;

// ---------------------------------------------------------------------------
// Value overrides (quality/value-overrides.yaml)
// ---------------------------------------------------------------------------

export const ValueOverrideSchema = z.object({
  testId: NonEmptyStringSchema,
  /** Whole-score override, or a single criterion override — never both on one entry. */
  overrideType: z.enum(["total-score", "criterion-score"]),
  criterionId: NonEmptyStringSchema.optional(),
  value: z.number().min(0).max(100),
  rationale: NonEmptyStringSchema,
  approver: NonEmptyStringSchema,
  date: IsoDateSchema,
})
  .superRefine((override, ctx) => {
    if (override.overrideType === "criterion-score" && !override.criterionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "criterion-score overrides must set criterionId",
        path: ["criterionId"],
      });
    }
    if (override.overrideType === "total-score" && override.criterionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "total-score overrides must not set criterionId",
        path: ["criterionId"],
      });
    }
  });
export type ValueOverride = z.infer<typeof ValueOverrideSchema>;

export const ValueOverridesFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  overrides: z.array(ValueOverrideSchema),
});
export type ValueOverridesFile = z.infer<typeof ValueOverridesFileSchema>;

// ---------------------------------------------------------------------------
// Saved named tag-expression selections (quality/saved-selections.yaml, Stage 05)
// ---------------------------------------------------------------------------

/** A named, reusable tag expression -- e.g. `smoke` -> `"@suite:smoke AND NOT @quarantined"` --
 * so `pw:run smoke` means the same thing every time instead of every invoker retyping the raw
 * expression (and risking a typo silently narrowing or widening the selection). */
export const SavedSelectionSchema = z.object({
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  expression: NonEmptyStringSchema,
});
export type SavedSelection = z.infer<typeof SavedSelectionSchema>;

export const SavedSelectionsFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  selections: z.array(SavedSelectionSchema),
});
export type SavedSelectionsFile = z.infer<typeof SavedSelectionsFileSchema>;

// ---------------------------------------------------------------------------
// Per-test authored metadata (attached in test source via defineQualityTest — Stage 02 helper;
// discovered/inventoried by the CLI runner built in a later stage)
// ---------------------------------------------------------------------------

export const DataImpactTagSchema = z.enum(["@readonly", "@mutating"]);
export const RiskTagSchema = z.enum([
  "@risk:critical",
  "@risk:high",
  "@risk:normal",
  "@risk:low",
]);

export const TestMetadataSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  objective: NonEmptyStringSchema,
  expectedOutcome: NonEmptyStringSchema,
  /** Requirement IDs this test validates. Empty array is allowed but must be explicit — see
   * validateMetadata.ts, which flags an empty list as NEEDS HUMAN REVIEW rather than silently
   * treating "unmapped" as fine. */
  requirementIds: z.array(NonEmptyStringSchema),
  tags: z.array(NonEmptyStringSchema).min(1),
});
export type TestMetadata = z.infer<typeof TestMetadataSchema>;

// ---------------------------------------------------------------------------
// Test inventory (future stage populates this by discovering TestMetadata + file location)
// ---------------------------------------------------------------------------

export const TestInventoryEntrySchema = TestMetadataSchema.extend({
  filePath: NonEmptyStringSchema,
  line: z.number().int().positive(),
});
export type TestInventoryEntry = z.infer<typeof TestInventoryEntrySchema>;

export const TestInventoryFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  generatedAt: z.string(),
  tests: z.array(TestInventoryEntrySchema),
});
export type TestInventoryFile = z.infer<typeof TestInventoryFileSchema>;

// ---------------------------------------------------------------------------
// Run results (future stage: the runner writes one of these per execution — Section 10.2)
// ---------------------------------------------------------------------------

export const RunResultStatusSchema = z.enum([
  "initial-pass",
  "retry-pass",
  "consistent-failure",
  "timeout",
  "skipped",
  "expected-failure",
  "quarantined",
  "setup-failure",
]);

export const TestRunOutcomeSchema = z.object({
  testId: NonEmptyStringSchema,
  status: RunResultStatusSchema,
  durationMs: z.number().nonnegative(),
  attempts: z.number().int().positive(),
});

/** The exact, validated execution configuration a run was launched with (Stage 05 task: "Capture
 * the normalized expression and exact execution configuration in the run manifest") -- only the
 * small, explicitly-supported set of options playwright-framework/cli/run-tests.ts ever forwards
 * to the underlying `playwright test` invocation, never an arbitrary passthrough. */
export const ExecutionConfigSchema = z.object({
  workers: z.number().int().positive().optional(),
  repeatEach: z.number().int().positive().optional(),
  reporter: z.string().optional(),
  /** Whether this specific invocation explicitly passed `--allow-production` -- deliberately not
   * "whether PLAYWRIGHT_ALLOW_PRODUCTION happened to be set in the ambient shell environment"; see
   * the Stage 05 Decision Log entry on why the CLI treats those as different things. */
  allowProductionFlagPassed: z.boolean(),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export const RunResultFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  runId: NonEmptyStringSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  initiator: NonEmptyStringSchema,
  environment: NonEmptyStringSchema,
  baseUrl: z.string(),
  gitCommit: NonEmptyStringSchema,
  tagExpression: z.string(),
  /** The compiled `--grep` regex source this run's selection was translated to (Stage 05) --
   * kept alongside the human-authored expression so "what was typed" and "what Playwright was
   * actually told to match" are both on record, not just the former. */
  compiledGrepPattern: z.string(),
  /** Every test ID the selection matched at launch time, from the same discovery+evaluation this
   * run's own preview mode uses -- so a run manifest can always be cross-checked against "what
   * would preview show right now" without re-deriving it from the grep pattern. */
  matchedTestIds: z.array(NonEmptyStringSchema),
  executionConfig: ExecutionConfigSchema,
  /** Deliberately left empty by Stage 05: populating per-test pass/fail/attempt outcomes requires
   * parsing Playwright's own run results, which is Stage 06's reporter work (spec Section 10.2).
   * Stage 05's manifest instead exists to prove exactly what was asked for and configured, not to
   * report what happened. */
  outcomes: z.array(TestRunOutcomeSchema),
});
export type RunResultFile = z.infer<typeof RunResultFileSchema>;

// ---------------------------------------------------------------------------
// Run REPORT (Stage 06 — spec Section 10.2): the rich, per-test diagnostic document the custom
// Playwright reporter (playwright-framework/reporting/normalizedReporter.ts) writes once a run
// finishes, and playwright-framework/cli/generate-run-report.ts renders to HTML. Distinct from
// RunResultFile above: that one records what a `pw:run` invocation was ASKED to do (Stage 05,
// written before execution); this one records what actually HAPPENED (Stage 06, written after).
// The two share a `runId` so they can be cross-referenced but are never merged into one file --
// Stage 05's manifest is written by the CLI process itself, Stage 06's report by a Playwright
// reporter running inside a separate `playwright test` child process, and forcing one writer to
// wait on/patch the other's file would add exactly the kind of fragile cross-process coordination
// this framework has otherwise avoided.
// ---------------------------------------------------------------------------

export const StepOutcomeSchema = z.object({
  title: NonEmptyStringSchema,
  /** Playwright's own step category: "test.step" for an authored Arrange/Act/Assert step,
   * "expect" for an individual assertion, "hook"/"fixture" for setup/teardown machinery. */
  category: NonEmptyStringSchema,
  durationMs: z.number().nonnegative(),
  status: z.enum(["passed", "failed", "skipped"]),
  error: z.string().optional(),
});
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

export const SuccessCheckpointSchema = z.object({
  name: NonEmptyStringSchema,
  /** Relative (never absolute) path to the attached screenshot, from the report file's own
   * directory -- spec Section 10.1: "contains no absolute path unless configured for local editor
   * linking" (which this framework does not enable -- DEC-004). */
  screenshotPath: z.string().optional(),
  validationDescription: NonEmptyStringSchema,
});

export const RunReportTestSchema = z.object({
  testId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  /** Repository-relative source path and 1-based line -- never an absolute path (Section 10.1). */
  filePath: NonEmptyStringSchema,
  line: z.number().int().positive(),
  tags: z.array(NonEmptyStringSchema),
  requirementIds: z.array(NonEmptyStringSchema),
  objective: z.string().optional(),
  expectedOutcome: z.string().optional(),
  status: RunResultStatusSchema,
  durationMs: z.number().nonnegative(),
  /** Total attempts Playwright made (1 + retries actually consumed for this test). */
  attempts: z.number().int().positive(),
  steps: z.array(StepOutcomeSchema),
  /** Count of `expect(...)`/`expect.poll(...)` steps Playwright itself recorded as actually
   * executed -- Section 10.1's "every claimed successful validation is backed by an executed
   * assertion" means this is read from Playwright's own step data, never inferred from source. */
  assertionCount: z.number().int().nonnegative(),
  /** Only present for a failing/timed-out test -- the first meaningful failure's own message,
   * redacted, with any absolute repository path rewritten relative (never fabricated when
   * Playwright reported no error, e.g. a plain timeout with no thrown error). */
  errorMessage: z.string().optional(),
  sanitizedStackTrace: z.string().optional(),
  successCheckpoints: z.array(SuccessCheckpointSchema),
  /** Relative paths to Playwright's own failure attachments, when captured. */
  failureScreenshotPath: z.string().optional(),
  tracePath: z.string().optional(),
  videoPath: z.string().optional(),
  consoleMessages: z.string().optional(),
  failedNetworkRequests: z.string().optional(),
  /** Plain-language explanations (Section 10.2) -- generated deterministically from the structured
   * data above (step/assertion counts, the first failing step's title), never a fabricated
   * narrative disconnected from what Playwright actually recorded. */
  whyPassed: z.string().optional(),
  whyFailed: z.string().optional(),
});
export type RunReportTest = z.infer<typeof RunReportTestSchema>;

export const RunReportCountsSchema = z.object({
  initialPass: z.number().int().nonnegative(),
  retryPass: z.number().int().nonnegative(),
  consistentFailure: z.number().int().nonnegative(),
  timeout: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  expectedFailure: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
  setupFailure: z.number().int().nonnegative(),
});

export const RunReportSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  runId: NonEmptyStringSchema,
  generatedAt: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().nonnegative(),
  initiator: NonEmptyStringSchema,
  environment: NonEmptyStringSchema,
  baseUrl: z.string(),
  gitCommit: NonEmptyStringSchema,
  workingTreeClean: z.boolean(),
  playwrightVersion: NonEmptyStringSchema,
  nodeVersion: NonEmptyStringSchema,
  operatingSystem: NonEmptyStringSchema,
  browserProjects: z.array(NonEmptyStringSchema),
  workers: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  tagExpression: z.string(),
  selectionSummary: z.object({
    matchedCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
  }),
  counts: RunReportCountsSchema,
  tests: z.array(RunReportTestSchema),
  /** Relative link to Playwright's own native HTML report, when generated alongside this one. */
  nativeReportPath: z.string().optional(),
});
export type RunReport = z.infer<typeof RunReportSchema>;

// ---------------------------------------------------------------------------
// Test evaluations (Stage 07 — quality/test-evaluations.yaml): the hand-authored half of the
// value/quality judgment split (see DEC-021). Two criteria genuinely require reading a specific
// test's own assertions/behavior rather than mechanical suite-wide facts —
// `assertion-strength-and-objective-traceability` (quality) and
// `security-compliance-data-integrity` (value) — so those live here, authored by a human or by an
// AI evaluator citing real evidence (Section 8.6: "AI may evaluate evidence and recommend
// criterion points, but must provide criterion-by-criterion rationale and confidence"). A test
// with no entry here is NOT scored generously by default — the Stage 07 evaluator
// (playwright-framework/evaluation/evaluateTest.ts) treats a missing entry as
// `needsHumanReview: true` for both of these criteria, exactly like an unconfirmed requirement.
// Every other value/quality criterion is computed fresh, mechanically, on every report generation
// (never stored here) so it can never silently go stale as the codebase changes.
// ---------------------------------------------------------------------------

export const EvaluationConfidenceSchema = z.enum(["high", "medium", "low"]);

/** Mirrors `playwright-framework/scoring/types.ts`'s `ScoreResult`/`CriterionResult` structurally
 * (that module is Stage 02's deterministic scoring arithmetic and stays the single source of
 * truth for the TypeScript shape) -- defined again here, as a real zod schema rather than
 * `z.custom`, so a `SuiteReview`'s embedded score results are genuinely structurally validated
 * like every other field, not merely type-cast through. */
export const CriterionResultSchema = z.object({
  criterionId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  weight: z.number(),
  points: z.number(),
  rationale: NonEmptyStringSchema,
  confidence: EvaluationConfidenceSchema,
  needsHumanReview: z.boolean(),
});
export type CriterionResultShape = z.infer<typeof CriterionResultSchema>;

export const ScoreResultSchema = z.object({
  modelVersion: NonEmptyStringSchema,
  total: z.number(),
  band: z.string().optional(),
  source: z.enum(["calculated", "override", "provisional"]),
  criteria: z.array(CriterionResultSchema),
  provisional: z.boolean(),
  overrideRef: z
    .object({
      testId: NonEmptyStringSchema,
      rationale: NonEmptyStringSchema,
      approver: NonEmptyStringSchema,
      date: NonEmptyStringSchema,
    })
    .optional(),
});
export type ScoreResultShape = z.infer<typeof ScoreResultSchema>;

export const TestEvaluationJudgmentSchema = z.object({
  criterionId: NonEmptyStringSchema,
  /** 0..the criterion's weight in the current value/quality model. Omit (or null) alongside
   * needsHumanReview: true for a criterion that cannot yet be honestly judged. */
  points: z.number().nonnegative().nullable().optional(),
  rationale: NonEmptyStringSchema,
  confidence: EvaluationConfidenceSchema,
  needsHumanReview: z.boolean(),
});
export type TestEvaluationJudgment = z.infer<typeof TestEvaluationJudgmentSchema>;

export const TestEvaluationEntrySchema = z.object({
  testId: NonEmptyStringSchema,
  evaluatedAt: IsoDateSchema,
  evaluatedBy: NonEmptyStringSchema,
  valueJudgments: z.array(TestEvaluationJudgmentSchema),
  qualityJudgments: z.array(TestEvaluationJudgmentSchema),
});
export type TestEvaluationEntry = z.infer<typeof TestEvaluationEntrySchema>;

export const TestEvaluationsFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  /** The `test-value-model.yaml` `modelVersion` these judgments were authored against — a value-
   * model version bump (Section 8.6: "a value-model change must trigger reevaluation of every
   * discovered test") is detected by the suite-review CLI comparing this against the live model
   * and flagging every entry here as stale until re-authored, rather than silently reusing
   * judgments made against a retired rubric. */
  modelVersion: NonEmptyStringSchema,
  evaluations: z.array(TestEvaluationEntrySchema),
});
export type TestEvaluationsFile = z.infer<typeof TestEvaluationsFileSchema>;

// ---------------------------------------------------------------------------
// Suite review (Stage 07 — Section 10.3): coverage analysis, duplicate detection, full value/
// quality scoring, and a prioritized human-review queue over every discovered application test.
// Written by playwright-framework/cli/suite-review.ts to
// artifacts/playwright/runs/suite-reviews/<reviewId>.{json,html}.
// ---------------------------------------------------------------------------

export const CoverageBucketSchema = z.object({
  covered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** What "total" counts, and what it deliberately excludes (Stage 07 acceptance criterion:
   * "coverage percentages state their denominator and exclusions") -- e.g. "requirements with
   * status needs-human-review or confirmed (2 placeholder and 0 retired requirements excluded)". */
  denominatorLabel: NonEmptyStringSchema,
});
export type CoverageBucket = z.infer<typeof CoverageBucketSchema>;

export const RequirementCoverageEntrySchema = z.object({
  requirementId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  status: RequirementStatusSchema,
  coveringTestIds: z.array(NonEmptyStringSchema),
  /** True when every covering test is currently skipped, quarantined, stale (outside the
   * freshness window), or last known to be failing -- Section 10.3's "requirements covered only
   * by skipped, quarantined, stale, or failing tests" -- false when there are zero covering tests
   * at all (that's "uncovered", a separate, more severe bucket). */
  coveredOnlyByUnhealthyTests: z.boolean(),
});
export type RequirementCoverageEntry = z.infer<typeof RequirementCoverageEntrySchema>;

export const DimensionCoverageEntrySchema = z.object({
  dimension: NonEmptyStringSchema,
  /** Per-tag test counts within this dimension, e.g. {"@readonly": 1, "@mutating": 1}. A tag
   * absent from this object was never used by any discovered test. */
  countsByTag: z.record(z.string(), z.number().int().nonnegative()),
});
export type DimensionCoverageEntry = z.infer<typeof DimensionCoverageEntrySchema>;

export const DuplicateCandidateSchema = z.object({
  testIds: z.array(NonEmptyStringSchema).min(2),
  sharedRequirementIds: z.array(NonEmptyStringSchema),
  sharedTags: z.array(NonEmptyStringSchema),
  /** 0..1 word-overlap similarity between the tests' own objective text -- a recommendation
   * signal only (Stage 07 task: "label them as recommendations, not automatic deletions"), never
   * an automatic removal. */
  objectiveSimilarity: z.number().min(0).max(1),
  rationale: NonEmptyStringSchema,
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

export const SuiteReviewTestEntrySchema = z.object({
  testId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  filePath: NonEmptyStringSchema,
  line: z.number().int().positive(),
  tags: z.array(NonEmptyStringSchema),
  requirementIds: z.array(NonEmptyStringSchema),
  objective: NonEmptyStringSchema,
  expectedOutcome: NonEmptyStringSchema,
  valueScore: ScoreResultSchema,
  qualityScore: ScoreResultSchema,
  lastKnownResult: z
    .object({
      status: NonEmptyStringSchema,
      runId: NonEmptyStringSchema,
      endedAt: z.string(),
      ageDays: z.number().nonnegative(),
      staleBeyondFreshnessWindow: z.boolean(),
      /** From the same run report's own recorded duration -- feeds the review queue's "low-value
       * tests consuming disproportionate execution time" signal (Section 10.3). Absent only if a
       * test has never executed (no lastKnownResult at all, a separate, earlier case). */
      durationMs: z.number().nonnegative(),
    })
    .optional(),
  quarantined: z.boolean(),
  recommendations: z.array(NonEmptyStringSchema),
});
export type SuiteReviewTestEntry = z.infer<typeof SuiteReviewTestEntrySchema>;

export const ReviewQueueItemSchema = z.object({
  testId: NonEmptyStringSchema,
  priority: z.number().int().nonnegative(),
  reasons: z.array(NonEmptyStringSchema).min(1),
});
export type ReviewQueueItemShape = z.infer<typeof ReviewQueueItemSchema>;

export const SuiteReviewChangeSchema = z.object({
  previousReviewId: NonEmptyStringSchema,
  previousGeneratedAt: z.string(),
  addedTestIds: z.array(NonEmptyStringSchema),
  removedTestIds: z.array(NonEmptyStringSchema),
  valueScoreChanges: z.array(
    z.object({ testId: NonEmptyStringSchema, previousTotal: z.number(), currentTotal: z.number() }),
  ),
  qualityScoreChanges: z.array(
    z.object({ testId: NonEmptyStringSchema, previousTotal: z.number(), currentTotal: z.number() }),
  ),
});

export const SuiteReviewSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  reviewId: NonEmptyStringSchema,
  generatedAt: z.string(),
  frameworkVersion: NonEmptyStringSchema,
  gitCommit: NonEmptyStringSchema,
  workingTreeClean: z.boolean(),
  valueModelVersion: NonEmptyStringSchema,
  freshnessWindowDays: z.number().int().positive(),
  parseErrorCount: z.number().int().nonnegative(),
  requirementCoverage: CoverageBucketSchema,
  riskWeightedCoverage: CoverageBucketSchema.extend({
    /** Documents the exact weighting rule used (DEC-022) so the percentage is never a mystery
     * number -- e.g. "critical=4, high=3, normal=2, low=1; an uncovered requirement is
     * conservatively weighted as @risk:critical (4) since its real risk is unconfirmed". */
    weightingRule: NonEmptyStringSchema,
  }),
  dimensionCoverage: z.array(DimensionCoverageEntrySchema),
  requirementDetails: z.array(RequirementCoverageEntrySchema),
  duplicateCandidates: z.array(DuplicateCandidateSchema),
  tests: z.array(SuiteReviewTestEntrySchema),
  valueScoreDistribution: z.record(z.string(), z.number().int().nonnegative()),
  qualityScoreDistribution: z.record(z.string(), z.number().int().nonnegative()),
  reviewQueue: z.array(ReviewQueueItemSchema),
  changesFromPreviousReview: SuiteReviewChangeSchema.optional(),
});
export type SuiteReview = z.infer<typeof SuiteReviewSchema>;
export type SuiteReviewChange = z.infer<typeof SuiteReviewChangeSchema>;

// ---------------------------------------------------------------------------
// Maintenance results (future stage: triage output against a failed run — Section 10.4)
// ---------------------------------------------------------------------------

export const MaintenanceClassificationSchema = z.enum([
  "product-defect",
  "test-defect",
  "environment-issue",
  "flaky-infrastructure",
  "needs-human-review",
]);

export const MaintenanceFindingSchema = z.object({
  testId: NonEmptyStringSchema,
  classification: MaintenanceClassificationSchema,
  rationale: NonEmptyStringSchema,
  confidence: z.enum(["high", "medium", "low"]),
  recommendedAction: NonEmptyStringSchema,
});

export const MaintenanceResultFileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  runId: NonEmptyStringSchema,
  generatedAt: z.string(),
  findings: z.array(MaintenanceFindingSchema),
});
export type MaintenanceResultFile = z.infer<typeof MaintenanceResultFileSchema>;
