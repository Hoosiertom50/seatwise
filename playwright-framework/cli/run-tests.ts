#!/usr/bin/env node
/**
 * Stage 05 — the tag-expression runner: the one command that turns a human-authored boolean tag
 * expression (or a saved named selection) into an actual, safe, auditable `playwright test`
 * invocation. This is the "authoritative execution engine" wiring the spec calls for (Stage 05
 * task: "Invoke the Playwright CLI as the authoritative execution engine and forward only
 * explicitly supported, validated options") — this script never reimplements test selection or
 * execution itself; it only computes a selection, previews it, validates it's safe, and (unless
 * asked for preview only) hands off to the real `playwright test` CLI.
 *
 * Usage:
 *   pnpm pw:run "<tag expression>"        run every test the expression selects
 *   pnpm pw:run --selection smoke         run a saved named selection (quality/saved-selections.yaml)
 *   pnpm pw:run "<expr>" --list           preview only -- print the matched tests, run nothing
 *   pnpm pw:run "<expr>" --allow-production   explicit, per-invocation opt-in for a configured
 *                                              production host (see the Decision Log entry on why
 *                                              this is a CLI flag and not just an env var)
 *   pnpm pw:run "<expr>" --workers 2 --repeat-each 3 --reporter list
 *                                          the only options this CLI forwards to Playwright
 *
 * What happens before anything runs (in order — every step fails loudly and stops the run rather
 * than falling through to the next):
 *   1. Parse the expression (or resolve --selection from quality/saved-selections.yaml).
 *   2. Validate every tag referenced in the expression against the live tag taxonomy — an unknown
 *      tag is rejected here, in plain language, before Playwright is ever invoked.
 *   3. Run findContradictions -- an expression that can never match anything is rejected here too.
 *   4. Statically discover every real, tagged application test (the same AST-based discovery
 *      playwright-framework/cli/lint-tests.ts already uses) and evaluate the expression against
 *      each one's own tags, via the exact same evaluateExpression this module's own unit tests
 *      cross-check against compileToGrepPattern -- so "what preview shows" and "what --grep will
 *      actually select" can never drift apart (Stage 05 acceptance criterion).
 *   5. A zero-test selection is reported plainly and exits non-zero -- it is never treated as (or
 *      confused with) a successful run of nothing.
 *   6. The environment/production preflight: is APP_URL a configured production host, and does the
 *      selection include any @mutating test? A mutating selection against production is refused
 *      outright, unconditionally. A read-only selection against production additionally requires
 *      BOTH this invocation to have passed --allow-production explicitly AND
 *      PLAYWRIGHT_ALLOW_PRODUCTION=1 to be set in the environment (Stage 11 final-audit Finding M1,
 *      2026-09-11 / DEC-033, 2026-09-14: the code previously checked only the flag, in drift from
 *      what PLAYWRIGHT_TESTING.md and this file's own messages always documented).
 *   7. Only then: compile the expression to a `--grep` pattern and spawn the real `playwright test`
 *      CLI via execFileSync with an argv array (never a shell string), and write a run manifest.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import {
  parseTagExpression,
  evaluateExpression,
  compileToGrepPattern,
  findContradictions,
  collectTagsInExpression,
  TagExpressionSyntaxError,
  type ExpressionNode,
} from "../runner/tagExpression.js";
import { discoverTestMetadataFromSource } from "../validation/discoverTestMetadata.js";
import { parseRunArgs, RUN_TESTS_HELP_TEXT, type ParsedRunArgs } from "../runner/parseRunArgs.js";
import { buildPlaywrightTestArgs } from "../runner/buildPlaywrightInvocation.js";
import { buildRunReportHint } from "../runner/runReportHint.js";
import {
  loadTagTaxonomy,
  loadSavedSelections,
  MetadataValidationError,
} from "../metadata/loaders.js";
import { RunResultFileSchema, type TestMetadata } from "../metadata/schemas.js";
import { getEnv } from "../../e2e/support/env.js";
import {
  resolveIsProduction,
  assertMutationAllowed,
  ProductionMutationBlockedError,
} from "../../e2e/support/productionGuard.js";

const ROOT = process.cwd();
const E2E_TESTS_DIR = resolve(ROOT, "e2e/tests");
const EXCLUDED_DIRS = new Set(["unit"]); // framework-support unit tests carry no quality tags

// ---------------------------------------------------------------------------
// Friendly, non-developer-facing failure reporting (Stage 05 audit gate: "Verify friendly error
// messages for a non-developer user"). Every exit path funnels through this so the tone and
// exit-code behavior are consistent everywhere, rather than each check rolling its own.
// ---------------------------------------------------------------------------

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`\npw:run cannot continue:\n\n  ${message}\n`);
  process.exit(1);
}

// Argv parsing lives in playwright-framework/runner/parseRunArgs.ts (pure, unit-tested directly in
// playwright-framework/tests/parseRunArgs.spec.ts) so it never has to be exercised only indirectly
// through this file's own `main()` side effects.

// ---------------------------------------------------------------------------
// Discover every real, tagged application test (mirrors playwright-framework/cli/lint-tests.ts's
// own discovery walk, deliberately -- this is the same discovery lint-tests already runs, so a
// test that lint-tests can see is exactly a test pw:run can see, and vice versa).
// ---------------------------------------------------------------------------

interface DiscoveredEntry {
  metadata: TestMetadata;
  filePath: string;
  line: number;
}

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
  const specFiles = findSpecFiles(E2E_TESTS_DIR).sort();
  const discovered: DiscoveredEntry[] = [];
  const parseErrorMessages: string[] = [];

  for (const filePath of specFiles) {
    const relPath = relative(ROOT, filePath);
    const source = readFileSync(filePath, "utf-8");
    const { tests, parseErrors } = discoverTestMetadataFromSource(filePath, source);
    for (const test of tests) {
      discovered.push({ metadata: test.metadata, filePath: relPath, line: test.line });
    }
    for (const parseError of parseErrors) {
      parseErrorMessages.push(`${relPath}:${parseError.line} ${parseError.message}`);
    }
  }

  if (parseErrorMessages.length > 0) {
    fail(
      `some tests' metadata couldn't be read, so pw:run can't safely compute a selection ` +
        `right now. Run \`pnpm pw:lint-tests\` to see and fix the underlying issue(s):\n\n` +
        parseErrorMessages.map((m) => `    - ${m}`).join("\n"),
    );
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  let args: ParsedRunArgs;
  try {
    args = parseRunArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(RUN_TESTS_HELP_TEXT);
    return;
  }

  if (args.expression && args.selectionName) {
    fail(`pass either a raw expression or --selection <name>, not both.`);
  }
  if (!args.expression && !args.selectionName) {
    fail(`nothing to run -- pass a tag expression or --selection <name>. Run with --help for usage.`);
  }

  // --- Load governance + resolve the expression to run -----------------------------------------
  let taxonomy;
  try {
    taxonomy = loadTagTaxonomy(resolve(ROOT, "quality/tag-taxonomy.yaml"));
  } catch (err) {
    if (err instanceof MetadataValidationError) fail(err.message);
    throw err;
  }

  let normalizedExpression: string;
  if (args.selectionName) {
    let selections;
    try {
      selections = loadSavedSelections(resolve(ROOT, "quality/saved-selections.yaml"));
    } catch (err) {
      if (err instanceof MetadataValidationError) fail(err.message);
      throw err;
    }
    const found = selections.selections.find((s) => s.name === args.selectionName);
    if (!found) {
      const known = selections.selections.map((s) => s.name).join(", ");
      fail(`no saved selection named "${args.selectionName}" -- known selections: ${known}`);
    }
    normalizedExpression = found!.expression;
  } else {
    normalizedExpression = args.expression!;
  }

  let ast: ExpressionNode;
  try {
    ast = parseTagExpression(normalizedExpression);
  } catch (err) {
    if (err instanceof TagExpressionSyntaxError) {
      fail(`this expression isn't valid: ${err.message}`);
    }
    throw err;
  }

  // --- Validate every referenced tag exists in the taxonomy -------------------------------------
  const knownTags = new Set<string>();
  for (const dimension of taxonomy.dimensions) {
    for (const tag of dimension.tags) knownTags.add(tag.name);
  }
  const aliasMap = new Map(taxonomy.aliases.map((a) => [a.alias, a.canonical]));
  const resolveTag = (tag: string): string => aliasMap.get(tag) ?? tag;

  const referencedTags = collectTagsInExpression(ast);
  const unknownTags = referencedTags.filter((tag) => !knownTags.has(resolveTag(tag)));
  if (unknownTags.length > 0) {
    fail(
      `this expression references a tag that doesn't exist: ${unknownTags.join(", ")}. ` +
        `Check quality/tag-taxonomy.yaml for the exact spelling of every valid tag.`,
    );
  }

  // --- Detect a self-contradictory expression before ever discovering or running anything -------
  const contradictions = findContradictions(ast, taxonomy);
  if (contradictions.length > 0) {
    fail(
      `this expression can never match anything:\n\n` +
        contradictions.map((c) => `    - ${c}`).join("\n") +
        `\n\n  Fix the expression so it doesn't require two mutually-exclusive tags at once.`,
    );
  }

  // --- Discover the real suite and evaluate the expression against it ---------------------------
  const allTests = discoverAllTests();
  const matched = allTests.filter((t) => evaluateExpression(ast, t.metadata.tags, taxonomy));

  if (matched.length === 0) {
    fail(
      `"${normalizedExpression}" matches 0 tests out of ${allTests.length} discovered. This is ` +
        `not a passing run of nothing -- it almost always means a typo in a tag name, or an ` +
        `expression that's more restrictive than intended. Nothing was run.`,
    );
  }

  const hasMutatingSelection = matched.some((t) =>
    evaluateExpression(parseTagExpression("@mutating"), t.metadata.tags, taxonomy),
  );
  const compiledPattern = compileToGrepPattern(ast);

  // --- Environment / production preflight ---------------------------------------------------------
  // Computed before preview mode's early return too: preview never executes anything (so it can
  // never itself violate the production/mutation guard), but a preview that stayed silent about a
  // production target would let someone believe an about-to-be-refused run was ready to go. Preview
  // always tells the truth about what would happen next.
  const env = getEnv();
  const isProduction = resolveIsProduction(env.APP_URL, env.PRODUCTION_HOSTNAMES);

  // Stage 11 final-audit Finding M1 (2026-09-11) / DEC-033 (2026-09-14): a production read-only run
  // requires BOTH factors -- this invocation's own explicit --allow-production flag AND the ambient
  // PLAYWRIGHT_ALLOW_PRODUCTION=1 environment variable -- not the flag alone. This supersedes DEC-017,
  // which deliberately made the flag the only signal; Tom reviewed Finding M1 (the docs/error messages
  // already described a two-factor gate that the code never actually enforced) and chose to make the
  // code match the documented, stricter design rather than relax the documentation. A shell that
  // merely has PLAYWRIGHT_ALLOW_PRODUCTION=1 left set from an earlier session still cannot run
  // anything against production without ALSO passing --allow-production on this specific invocation,
  // and vice versa -- both are required, matching PLAYWRIGHT_TESTING.md exactly. Computed before
  // preview mode's early return too, same as isProduction above, so preview never misrepresents
  // whether a real run would actually be allowed.
  const productionReadAllowed = args.allowProduction && env.PLAYWRIGHT_ALLOW_PRODUCTION;

  // --- Preview mode: print and stop, run nothing -------------------------------------------------
  if (args.preview) {
    printPreview(normalizedExpression, matched, hasMutatingSelection, isProduction, env.APP_URL, productionReadAllowed);
    return;
  }

  if (isProduction && !productionReadAllowed) {
    // Read-only-but-still-missing-a-factor case, and the always-refused mutating case, both get a
    // friendly, specific message here before assertMutationAllowed's own (correct, but more terse)
    // error would otherwise fire deeper in globalSetup.
    if (hasMutatingSelection) {
      fail(
        `"${env.APP_URL}" is a configured production host and this selection includes at least ` +
          `one @mutating test. Mutating tests may never run against production, with or without ` +
          `--allow-production. Narrow the selection to @readonly tests, or point APP_URL at a ` +
          `non-production environment.`,
      );
    }
    const missing: string[] = [];
    if (!args.allowProduction) missing.push("the --allow-production flag on this invocation");
    if (!env.PLAYWRIGHT_ALLOW_PRODUCTION) missing.push("PLAYWRIGHT_ALLOW_PRODUCTION=1 in the environment");
    fail(
      `"${env.APP_URL}" is a configured production host. Even a fully read-only selection needs ` +
        `BOTH --allow-production on this invocation AND PLAYWRIGHT_ALLOW_PRODUCTION=1 set in the ` +
        `environment -- missing: ${missing.join(" and ")}. Set/pass both if you really mean to ` +
        `read from production.`,
    );
  }

  // Defense in depth: re-check with the same guard globalSetup uses, in case this preflight and
  // that one ever drift. Recomputes the same two-factor condition explicitly rather than assuming
  // the preflight above already enforced it, so the two checks can never silently diverge.
  try {
    assertMutationAllowed({
      baseURL: env.APP_URL,
      hasMutatingSelection,
      env: { ...env, PLAYWRIGHT_ALLOW_PRODUCTION: isProduction && productionReadAllowed },
    });
  } catch (err) {
    if (err instanceof ProductionMutationBlockedError || err instanceof Error) {
      fail(err.message);
    }
    throw err;
  }

  // --- Spawn the real Playwright CLI -- argv array, never a shell string -------------------------
  // See playwright-framework/runner/buildPlaywrightInvocation.ts for why matched tests' own spec
  // files must be passed alongside --grep (Stage 05 audit finding: --grep alone lets an untagged
  // test outside the discovered/matched set slip into the real run even though preview never
  // considered it a candidate).
  const playwrightArgs = buildPlaywrightTestArgs({
    compiledPattern,
    matchedFilePaths: matched.map((t) => t.filePath),
    workers: args.workers,
    repeatEach: args.repeatEach,
    reporter: args.reporter,
  });

  // Generated once and shared with the spawned child (below) so Stage 05's manifest and Stage 06's
  // run report (playwright-framework/reporting/normalizedReporter.ts, which reads PW_RUN_ID) refer
  // to the same run by the same ID, without either file needing to read the other's output.
  const runId = randomUUID();

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Replaces Stage 01's temporary PW_SIMULATE_MUTATING_SELECTION (see DEC-007's tracked
    // follow-up and the Stage 05 Decision Log entry) with this run's own real, computed answer.
    PW_RUN_HAS_MUTATING_SELECTION: hasMutatingSelection ? "1" : "0",
    PLAYWRIGHT_ALLOW_PRODUCTION: isProduction && productionReadAllowed ? "1" : "0",
    PW_RUN_ID: runId,
    PW_RUN_TAG_EXPRESSION: normalizedExpression,
    PW_RUN_INITIATOR: process.env.PW_RUN_INITIATOR || "pw:run CLI",
  };

  // eslint-disable-next-line no-console
  console.log(
    `\nRunning ${matched.length} test(s) matching "${normalizedExpression}"` +
      (hasMutatingSelection ? " (includes @mutating tests)" : " (read-only)") +
      "...\n",
  );

  const startedAt = new Date().toISOString();
  let exitCode = 0;
  try {
    execFileSync("pnpm", playwrightArgs, { stdio: "inherit", env: childEnv });
  } catch (err) {
    const status = (err as { status?: number }).status;
    exitCode = typeof status === "number" ? status : 1;
  }
  const endedAt = new Date().toISOString();

  writeRunManifest({
    runId,
    startedAt,
    endedAt,
    normalizedExpression,
    compiledPattern,
    matched,
    env,
    args,
  });

  // AUDIT FINDING (fixed live): this used to print the "Run report: ...html (pnpm pw:report:run
  // ... to open it)" hint unconditionally, regardless of whether the reporter actually produced
  // one. Passing this CLI's own documented `--reporter <value>` flag (its own --help text
  // recommends `--reporter list`) makes Playwright's CLI replace its ENTIRE configured reporter
  // array with just that one reporter -- silently disabling both the native html reporter AND
  // Stage 06's own normalizedReporter, so no run-report JSON/HTML is written at all. Reproduced
  // live: `pnpm pw:run "@readonly" --allow-production --reporter list` printed a confident "Run
  // report: .../<runId>.html" hint for a file that was never created. Checking for the file before
  // claiming it exists turns a misleading dead link into an honest, actionable message.
  const runReportHtmlPath = resolve(ROOT, "artifacts/playwright/runs/run-reports", `${runId}.html`);
  // eslint-disable-next-line no-console
  console.log(buildRunReportHint(runId, args.reporter, existsSync(runReportHtmlPath)));

  process.exit(exitCode);
}

function printPreview(
  expression: string,
  matched: DiscoveredEntry[],
  hasMutatingSelection: boolean,
  isProduction: boolean,
  appUrl: string,
  productionReadAllowed: boolean,
): void {
  // eslint-disable-next-line no-console
  console.log(`\n"${expression}" matches ${matched.length} test(s):\n`);
  for (const test of matched) {
    const dataImpact = test.metadata.tags.includes("@mutating") ? "mutating" : "readonly";
    // eslint-disable-next-line no-console
    console.log(`  [${dataImpact}] ${test.metadata.id}`);
    // eslint-disable-next-line no-console
    console.log(`      ${test.metadata.title}`);
    // eslint-disable-next-line no-console
    console.log(`      tags: ${test.metadata.tags.join(", ")}`);
    // eslint-disable-next-line no-console
    console.log(`      ${test.filePath}:${test.line}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nOverall: ${hasMutatingSelection ? "includes at least one @mutating test" : "entirely read-only"}. Nothing was run (preview only).`,
  );

  // Preview never blocks on the production/mutation guard (there is nothing to block -- nothing
  // executes), but it never stays silent about what actually running this selection would do.
  if (isProduction) {
    if (hasMutatingSelection) {
      // eslint-disable-next-line no-console
      console.log(
        `\nNote: "${appUrl}" is a configured production host. Running this selection for real ` +
          `would be REFUSED unconditionally -- it includes at least one @mutating test, and ` +
          `mutating tests may never run against production.`,
      );
    } else if (!productionReadAllowed) {
      // eslint-disable-next-line no-console
      console.log(
        `\nNote: "${appUrl}" is a configured production host. This selection is read-only, but ` +
          `running it for real would still require BOTH --allow-production on that invocation AND ` +
          `PLAYWRIGHT_ALLOW_PRODUCTION=1 set in the environment.`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `\nNote: "${appUrl}" is a configured production host. This selection is read-only and ` +
          `both --allow-production and PLAYWRIGHT_ALLOW_PRODUCTION=1 are set, so running it for ` +
          `real would be allowed.`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log("");
}

function writeRunManifest(input: {
  runId: string;
  startedAt: string;
  endedAt: string;
  normalizedExpression: string;
  compiledPattern: string;
  matched: DiscoveredEntry[];
  env: ReturnType<typeof getEnv>;
  args: ParsedRunArgs;
}): void {
  const { runId, startedAt, endedAt, normalizedExpression, compiledPattern, matched, env, args } = input;

  let gitCommit = "unknown";
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
  } catch {
    // No git available in this environment -- recorded as "unknown" rather than failing the run
    // over a manifest field that isn't essential to what actually happened.
  }

  const manifest = RunResultFileSchema.parse({
    schemaVersion: "1.0.0",
    runId,
    startedAt,
    endedAt,
    initiator: process.env.PW_RUN_INITIATOR || "pw:run CLI",
    environment: env.CI ? "ci" : "local",
    baseUrl: env.APP_URL,
    gitCommit,
    tagExpression: normalizedExpression,
    compiledGrepPattern: compiledPattern,
    matchedTestIds: matched.map((t) => t.metadata.id),
    executionConfig: {
      workers: args.workers,
      repeatEach: args.repeatEach,
      reporter: args.reporter,
      allowProductionFlagPassed: args.allowProduction,
    },
    outcomes: [],
  });

  const manifestDir = resolve(ROOT, "artifacts/playwright/runs/run-manifests");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = resolve(manifestDir, `${runId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  // eslint-disable-next-line no-console
  console.log(`\nRun manifest written: ${relative(ROOT, manifestPath)}`);
}

main();
