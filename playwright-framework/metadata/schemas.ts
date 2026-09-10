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
