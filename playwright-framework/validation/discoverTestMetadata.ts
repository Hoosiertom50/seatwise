/**
 * Stage 04 — statically discovers every `defineQualityTest({...}, ...)` call's metadata literal
 * from real test-file source, without ever importing or running the file. This is what closes a
 * gap left open since Stage 02: `validateAllTestMetadata` (playwright-framework/metadata/
 * validateMetadata.ts) has existed since Stage 02 and is unit-tested against synthetic data, but
 * nothing before this stage ever fed it the REAL test suite's actual metadata -- `pw:validate-
 * metadata` only checked the quality/*.yaml governance files against each other, never against
 * what test files actually declare. `playwright-framework/cli/lint-tests.ts` is what wires this
 * discovery function's output into that existing validator against the real e2e/tests/** files.
 *
 * Deliberately static (AST-only, no `require`/dynamic `import`): running each test file to collect
 * its metadata would mean either loading Playwright's own test-collection machinery outside a real
 * test run (fragile) or executing arbitrary test-file top-level code as a side effect of "just
 * checking metadata" -- neither of which "invalid metadata fails before execution" (Stage 01/02's
 * established principle) should require. A literal-only evaluator is a deliberate, narrow
 * trade-off: authored metadata objects are simple literals in every real test in this repo (no
 * computed values, no spreads), and a metadata object that ISN'T a plain literal is exactly the
 * kind of thing a reviewer should have to look at anyway, so it is reported as a parse error rather
 * than silently skipped or evaluated unsafely.
 */

import * as ts from "typescript";
import type { TestMetadata } from "../metadata/schemas.js";

export interface DiscoveredTest {
  metadata: TestMetadata;
  filePath: string;
  line: number; // 1-based, where the defineQualityTest(...) call starts
}

export interface MetadataParseError {
  filePath: string;
  line: number;
  message: string;
}

export interface DiscoveryResult {
  tests: DiscoveredTest[];
  parseErrors: MetadataParseError[];
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Evaluates a narrow subset of literal expressions -- string/template literals, arrays of
 * strings, and plain object literals of those -- refusing (returns undefined) anything else
 * (identifiers, spreads, computed properties, function calls, template interpolation). */
function evaluateLiteral(node: ts.Expression): unknown {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) return undefined;
      const value = evaluateLiteral(element);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) return undefined;
      const name = prop.name;
      let key: string | undefined;
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
        key = ts.isIdentifier(name) ? name.text : name.text;
      }
      if (!key) return undefined;
      const value = evaluateLiteral(prop.initializer);
      if (value === undefined) return undefined;
      result[key] = value;
    }
    return result;
  }
  return undefined;
}

/**
 * Scans `sourceText` (from `filePath`, used only for reporting) for every top-level
 * `defineQualityTest(metadataLiteral, ...)` call and attempts to statically evaluate its first
 * argument as a `TestMetadata` object. A call whose metadata argument isn't a plain literal is
 * reported as a parse error (never silently skipped), so a reviewer knows discovery couldn't see
 * it -- e.g. it doesn't count toward duplicate-ID or requirement-mapping checks.
 */
export function discoverTestMetadataFromSource(filePath: string, sourceText: string): DiscoveryResult {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const tests: DiscoveredTest[] = [];
  const parseErrors: MetadataParseError[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText() === "defineQualityTest") {
      const line = lineOf(sourceFile, node);
      const [metadataArg] = node.arguments;
      if (!metadataArg || !ts.isObjectLiteralExpression(metadataArg)) {
        parseErrors.push({
          filePath,
          line,
          message: "defineQualityTest's first argument is not a plain object literal -- cannot statically discover its metadata.",
        });
      } else {
        const evaluated = evaluateLiteral(metadataArg);
        if (evaluated === undefined || typeof evaluated !== "object") {
          parseErrors.push({
            filePath,
            line,
            message: "defineQualityTest's metadata object contains a non-literal value (a variable, function call, spread, or computed property) -- cannot statically discover it.",
          });
        } else {
          const candidate = evaluated as Record<string, unknown>;
          if (
            typeof candidate.id === "string" &&
            typeof candidate.title === "string" &&
            typeof candidate.objective === "string" &&
            typeof candidate.expectedOutcome === "string" &&
            Array.isArray(candidate.requirementIds) &&
            Array.isArray(candidate.tags)
          ) {
            tests.push({
              metadata: candidate as unknown as TestMetadata,
              filePath,
              line,
            });
          } else {
            parseErrors.push({
              filePath,
              line,
              message: "defineQualityTest's metadata literal is missing one or more required fields (id, title, objective, expectedOutcome, requirementIds, tags).",
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return { tests, parseErrors };
}
