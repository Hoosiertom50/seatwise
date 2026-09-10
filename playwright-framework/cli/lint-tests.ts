#!/usr/bin/env node
/**
 * Stage 04 — enforces the test-authoring standards (Section 7.2/7.3/7.4) and closes the "governed
 * metadata is validated against synthetic data but never against the real test suite" gap left
 * open since Stage 02, all in one command:
 *
 *  1. Static-analysis rules (playwright-framework/validation/lintRules.ts) against every real
 *     e2e/tests/**\/*.spec.ts file (excluding e2e/tests/unit/**, which are framework-support unit
 *     tests with no Playwright page/selector surface): raw selectors, raw screenshots, fixed
 *     waits, test.only, unreasoned skip/fixme/fail, swallowed errors, missing assertions.
 *  2. Statically discovers every real `defineQualityTest({...}, ...)` metadata literal
 *     (playwright-framework/validation/discoverTestMetadata.ts) and runs it through the SAME
 *     cross-cutting validator Stage 02 built and unit-tested (unknown tags, duplicate IDs, missing
 *     requirement mappings, and — new this stage — stale/retired requirement references), which
 *     until now had never been run against anything but synthetic test data in its own spec file.
 *  3. A naming-convention check (Stage 04 task: "Define naming and directory conventions"): every
 *     test ID declared in `<feature>.spec.ts` must be prefixed `<feature>.` (matching the
 *     convention already used by guest-management.spec.ts/guest-viewing.spec.ts), so a test's ID
 *     always tells a reader which file to open.
 *
 * Run via `pnpm pw:lint-tests`; folded into `pnpm pw:validate`. Exits non-zero on any hard
 * failure. `needsHumanReview` metadata flags and lint exceptions-in-use are printed but never fail
 * the run — they are visibility, not blockers (spec Section 8.6 / Stage 04's "documented exception
 * mechanism requiring rationale and review").
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { checkTestSource } from "../validation/lintRules.js";
import { discoverTestMetadataFromSource } from "../validation/discoverTestMetadata.js";
import { validateAllTestMetadata } from "../metadata/validateMetadata.js";
import { loadRequirements, loadTagTaxonomy, MetadataValidationError } from "../metadata/loaders.js";
import type { TestMetadata } from "../metadata/schemas.js";

const ROOT = process.cwd();
const E2E_TESTS_DIR = resolve(ROOT, "e2e/tests");
const EXCLUDED_DIRS = new Set(["unit"]); // framework-support unit tests, not application E2E tests

function findSpecFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      results.push(...findSpecFiles(fullPath));
    } else if (entry.endsWith(".spec.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

function main(): void {
  const specFiles = findSpecFiles(E2E_TESTS_DIR).sort();
  const hardFailures: string[] = [];
  const reviewNotes: string[] = [];

  // --- 1 & 3: per-file static rules + naming convention -------------------------------------
  const allDiscovered: { metadata: TestMetadata; filePath: string; line: number }[] = [];

  for (const filePath of specFiles) {
    const relPath = relative(ROOT, filePath);
    const source = readFileSync(filePath, "utf-8");

    const { issues, exceptionsUsed } = checkTestSource(filePath, source);
    for (const issue of issues) {
      hardFailures.push(`${relPath}:${issue.line} [${issue.rule}] ${issue.message}`);
    }
    for (const exception of exceptionsUsed) {
      reviewNotes.push(
        `${relPath}:${exception.line} exception for "${exception.rule}" -- ${exception.rationale}`,
      );
    }

    const { tests, parseErrors } = discoverTestMetadataFromSource(filePath, source);
    for (const parseError of parseErrors) {
      hardFailures.push(`${relPath}:${parseError.line} [metadata-discovery] ${parseError.message}`);
    }

    const featureSlug = basename(filePath, ".spec.ts");
    for (const discovered of tests) {
      if (!discovered.metadata.id.startsWith(`${featureSlug}.`)) {
        hardFailures.push(
          `${relPath}:${discovered.line} [naming-convention] test id "${discovered.metadata.id}" must start with "${featureSlug}." to match its file name`,
        );
      }
      allDiscovered.push({ metadata: discovered.metadata, filePath: relPath, line: discovered.line });
    }
  }

  // --- 2: governed-metadata validation against the REAL discovered test suite ---------------
  let requirements, taxonomy;
  try {
    requirements = loadRequirements(resolve(ROOT, "quality/requirements.yaml"));
    taxonomy = loadTagTaxonomy(resolve(ROOT, "quality/tag-taxonomy.yaml"));
  } catch (err) {
    if (err instanceof MetadataValidationError) {
      // eslint-disable-next-line no-console
      console.error(`Lint FAILED — could not load governance files:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const metadataSummary = validateAllTestMetadata(
    allDiscovered.map((d) => d.metadata),
    taxonomy,
    requirements,
  );
  for (const issue of metadataSummary.issues) {
    const line = `test "${issue.testId}": ${issue.message}`;
    if (issue.needsHumanReview) {
      reviewNotes.push(`[needs-human-review] ${line}`);
    } else {
      hardFailures.push(`[metadata] ${line}`);
    }
  }

  // --- Report ---------------------------------------------------------------------------------
  if (reviewNotes.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`${reviewNotes.length} item(s) noted for human review (not blocking):\n`);
    for (const note of reviewNotes) {
      // eslint-disable-next-line no-console
      console.log(`  - ${note}`);
    }
    // eslint-disable-next-line no-console
    console.log("");
  }

  if (hardFailures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Lint FAILED — ${hardFailures.length} issue(s):\n`);
    for (const failure of hardFailures) {
      // eslint-disable-next-line no-console
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `Lint OK: ${specFiles.length} test file(s), ${allDiscovered.length} discovered test(s), 0 hard failures.`,
  );
}

main();
