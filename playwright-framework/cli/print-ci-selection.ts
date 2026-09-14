#!/usr/bin/env node
/**
 * Stage 10 — prints the exact `--grep` pattern and matched spec files for a saved named selection
 * (`quality/saved-selections.yaml`), so a CI workflow can spawn `playwright test` directly with
 * genuine sharding/blob-reporter support that `pnpm pw:run` (Stage 05) does not offer today --
 * `parseRunArgs.ts` forwards only `--workers`/`--repeat-each`/`--reporter` (a single Playwright-
 * native reporter NAME, which replaces the whole configured reporter array -- Stage 06's own
 * disclosed finding), and has no `--shard` support at all. Rather than widen Stage 05's already-
 * audited CLI's scope to accommodate CI's own sharding/report-merging needs, this is a separate,
 * narrowly-scoped, read-only script: it reuses the exact same selection primitives `pw:run` itself
 * uses (`evaluateExpression`, `compileToGrepPattern` from `playwright-framework/runner/
 * tagExpression.ts`) so "what `pw:run --selection <name> --list` would show you" and "what this
 * prints for CI to spawn" can never drift apart -- it never re-derives selection semantics, only
 * the file-discovery walk itself (mirroring `playwright-framework/cli/lint-tests.ts` and `run-
 * tests.ts`'s own existing, deliberately-duplicated discovery walk, per each file's own header
 * comment -- this codebase already accepts one independent copy per CLI rather than forcing a
 * shared module for it).
 *
 * This intentionally bypasses `pw:run`'s own environment/production-mutation preflight (DEC-018
 * already discloses that a bare `playwright test --grep` invocation does this same bypass). That is
 * an acceptable, disclosed limitation specifically for CI: `PRODUCTION_HOSTNAMES` is always empty
 * here (DEC-005 -- no real production deployment exists), so the guard would be a no-op regardless.
 * This script must never be used to run a selection against a real, configured production host --
 * `pnpm pw:run` remains the only safe way to do that, exactly as DEC-018 and PLAYWRIGHT_TESTING.md
 * already state.
 *
 * Usage:
 *   pnpm exec tsx playwright-framework/cli/print-ci-selection.ts <selection-name>
 *
 * Output (stdout, two lines, both consumed by .github/workflows/ci.yml):
 *   line 1: the compiled --grep pattern
 *   line 2: matched spec files, space-separated, repo-relative
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { parseTagExpression, evaluateExpression, compileToGrepPattern } from "../runner/tagExpression.js";
import { discoverTestMetadataFromSource } from "../validation/discoverTestMetadata.js";
import { loadSavedSelections, loadTagTaxonomy, MetadataValidationError } from "../metadata/loaders.js";
import type { TestMetadata } from "../metadata/schemas.js";

const ROOT = process.cwd();
const E2E_TESTS_DIR = resolve(ROOT, "e2e/tests");
const EXCLUDED_DIRS = new Set(["unit"]); // framework-support unit tests carry no quality tags

interface DiscoveredEntry {
  metadata: TestMetadata;
  filePath: string;
}

// Mirrors run-tests.ts's own findSpecFiles/discoverAllTests exactly (see this file's header
// comment for why this is a deliberate, narrowly-scoped duplication rather than a shared import).
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

function discoverAllTests(): DiscoveredEntry[] {
  const discovered: DiscoveredEntry[] = [];
  for (const filePath of findSpecFiles(E2E_TESTS_DIR).sort()) {
    const relPath = relative(ROOT, filePath);
    const source = readFileSync(filePath, "utf-8");
    const { tests, parseErrors } = discoverTestMetadataFromSource(filePath, source);
    if (parseErrors.length > 0) {
      console.error(`print-ci-selection: ${relPath} has metadata parse errors -- run \`pnpm pw:lint-tests\` first.`);
      process.exit(1);
    }
    for (const test of tests) discovered.push({ metadata: test.metadata, filePath: relPath });
  }
  return discovered;
}

function main(): void {
  const selectionName = process.argv[2];
  if (!selectionName) {
    console.error("Usage: print-ci-selection.ts <selection-name>");
    process.exit(1);
  }

  let selections;
  try {
    selections = loadSavedSelections(resolve(ROOT, "quality/saved-selections.yaml"));
  } catch (err) {
    console.error(`print-ci-selection: could not load quality/saved-selections.yaml: ${err instanceof MetadataValidationError ? err.message : String(err)}`);
    process.exit(1);
  }

  const selection = selections.selections.find((s) => s.name === selectionName);
  if (!selection) {
    console.error(`print-ci-selection: no saved selection named "${selectionName}" in quality/saved-selections.yaml.`);
    process.exit(1);
  }

  const taxonomy = loadTagTaxonomy(resolve(ROOT, "quality/tag-taxonomy.yaml"));
  const expression = parseTagExpression(selection.expression);
  const compiledPattern = compileToGrepPattern(expression);
  const allTests = discoverAllTests();
  const matched = allTests.filter((t) => evaluateExpression(expression, t.metadata.tags, taxonomy));

  if (matched.length === 0) {
    console.error(
      `print-ci-selection: selection "${selectionName}" ("${selection.expression}") matches ZERO tests. ` +
        `Refusing to print an invocation for a selection that would run nothing -- this is exactly the ` +
        `kind of misconfiguration Stage 10's zero-test-run guard exists to catch, one step earlier.`,
    );
    process.exit(1);
  }

  const uniqueFiles = [...new Set(matched.map((t) => t.filePath))];
  console.log(compiledPattern);
  console.log(uniqueFiles.join(" "));
}

main();
