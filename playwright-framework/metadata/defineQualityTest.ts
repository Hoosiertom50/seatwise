/**
 * Stage 02 — thin typed wrapper around Playwright's native `test()` that requires governed
 * metadata (id, objective, expectedOutcome, requirementIds, tags) and validates it — including
 * tag-taxonomy compliance — at collection time, before any test body runs. An invalid selection
 * throws during collection, which Playwright surfaces as a hard failure before "Running N tests"
 * ever prints: exactly the "invalid metadata fails before execution" behavior Stage 01's
 * production guard already established for environment misconfiguration.
 *
 * This intentionally uses Playwright's native `test(title, { tag, annotation }, body)` form
 * (Section 9: "native tag/annotation helpers or a thin typed metadata wrapper") rather than a
 * parallel test-registration system, so every other Playwright feature (`--grep`, HTML report
 * tag filtering, VS Code extension, `test.step`, fixtures) keeps working unmodified. The
 * taxonomy-aware AND/OR/NOT/parenthesized query language required by Section 9.2 is a CLI-level
 * concern for a later stage's runner, layered on top of these same native tags — it is not part
 * of this per-test authoring helper.
 */

import { test as base } from "@playwright/test";
import { TestMetadataSchema, type TestMetadata } from "./schemas.js";
import { loadTagTaxonomy } from "./loaders.js";
import { validateTags } from "./tagValidation.js";
import { resolve } from "node:path";

// Resolved relative to process.cwd() rather than import.meta.dirname/__dirname: this file is
// compiled under CommonJS (tsconfig.json `module: commonjs`, no `import.meta` support), and every
// supported entry point (`pnpm pw:test`, `pnpm pw:list`, `tsc --noEmit`) is invoked from the repo
// root by convention (see package.json scripts), so process.cwd() reliably IS the repo root.

export class QualityTestMetadataError extends Error {
  constructor(title: string, issues: string[]) {
    super(
      `Invalid quality-test metadata for "${title}":\n` +
        issues.map((issue) => `  - ${issue}`).join("\n"),
    );
    this.name = "QualityTestMetadataError";
  }
}

let cachedTaxonomyPath: string | undefined;
function taxonomyPath(): string {
  cachedTaxonomyPath ??= resolve(process.cwd(), "quality/tag-taxonomy.yaml");
  return cachedTaxonomyPath;
}

/**
 * Validates `metadata` against the schema and the live tag taxonomy. Throws
 * QualityTestMetadataError (synchronously, at collection time) on any failure. Exported
 * separately from `defineQualityTest` so unit tests can exercise validation without needing a
 * running Playwright test context.
 */
export function validateQualityTestMetadata(metadata: TestMetadata): void {
  const schemaResult = TestMetadataSchema.safeParse(metadata);
  if (!schemaResult.success) {
    throw new QualityTestMetadataError(
      metadata.title ?? metadata.id ?? "(untitled)",
      schemaResult.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  const taxonomy = loadTagTaxonomy(taxonomyPath());
  const tagResult = validateTags(metadata.tags, taxonomy);
  if (!tagResult.valid) {
    throw new QualityTestMetadataError(metadata.title, tagResult.errors);
  }
}

type QualityTestBody = Parameters<typeof base>[2];

/**
 * Defines a Playwright test carrying governed quality metadata. Usage:
 *
 *   defineQualityTest({
 *     id: "guest-list.add-guest",
 *     title: "adds a guest to the wedding",
 *     objective: "Confirms a planner can add a guest and see it reflected in the guest list.",
 *     expectedOutcome: "The new guest appears in the list with the entered name and tier.",
 *     requirementIds: ["REQ-GUEST-LIST"],
 *     tags: ["@mutating", "@feature:guests", "@risk:normal"],
 *   }, async ({ page }) => { ... });
 */
export function defineQualityTest(metadata: TestMetadata, body: QualityTestBody): void {
  validateQualityTestMetadata(metadata);
  base(
    metadata.title,
    {
      tag: metadata.tags,
      annotation: [
        { type: "quality-test-id", description: metadata.id },
        { type: "objective", description: metadata.objective },
        { type: "expected-outcome", description: metadata.expectedOutcome },
        { type: "requirement-ids", description: metadata.requirementIds.join(",") },
      ],
    },
    body,
  );
}
