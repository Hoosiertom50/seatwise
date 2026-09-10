/**
 * Stage 04 — static, AST-based enforcement of the test-authoring standards in spec Section 7.2
 * ("Page and component objects") and Section 7.3 ("Test isolation and reliability"), plus the
 * evidence rule in 7.4 ("successful tests must capture screenshots only through an explicit named
 * evidence helper"). Operates on parsed TypeScript source (via the `typescript` compiler API,
 * already a root devDependency), not on running Playwright -- so violations are caught before a
 * single browser launches, the same "fails before execution" posture Stage 01's production guard
 * and Stage 02's metadata validation already established.
 *
 * Deliberately implemented as a small hand-written checker rather than an ESLint plugin: this repo
 * has no root-level ESLint of its own (only apps/web does, scoped to the Next.js app and outside
 * this project's own tsconfig include list -- see DEC-013), and a hand-written AST walk keeps this
 * in the same "plain, unit-tested TypeScript module" style as every other framework validator
 * (tagValidation.ts, validateMetadata.ts) rather than introducing a second, differently-shaped
 * tool with its own config format and plugin API to keep in sync.
 *
 * Scope: these rules apply to application E2E test files (e2e/tests/**\/*.spec.ts, excluding
 * e2e/tests/unit/**, which are framework-support unit tests with no Playwright page/selector
 * surface at all) -- never to page/component objects, fixtures, or the framework's own code, which
 * legitimately contain the raw Playwright calls these rules forbid *in test files* (spec Section
 * 7.2: "except selectors used exclusively by framework self-tests").
 */

import * as ts from "typescript";

export type LintRuleId =
  | "raw-selector-in-test"
  | "raw-screenshot-in-test"
  | "fixed-wait"
  | "test-only"
  | "unreasoned-skip"
  | "swallowed-error"
  | "missing-assertion";

export interface LintIssue {
  rule: LintRuleId;
  line: number; // 1-based
  message: string;
}

export interface LintException {
  rule: LintRuleId | "*";
  line: number; // 1-based, the line the exception comment was found on
  rationale: string;
}

export interface LintResult {
  issues: LintIssue[];
  /** Exceptions that were actually applied (suppressed a would-be issue) — the "documented
   * exception mechanism requiring rationale and review" (Stage 04 task) surfaces here so a
   * reviewer can see every exception in use, not just the issues that survived. */
  exceptionsUsed: LintException[];
}

const EXCEPTION_COMMENT =
  /\/\/\s*pw-lint-exception:\s*([a-z*-]+)\s*--\s*(.+?)\s*$/;

/** Methods that only ever make sense called directly on a raw `page`/`context`/`frame` object to
 * locate or act on an element -- the "raw selector mechanics" Section 7.2 says test files must not
 * contain. Page/component objects are exactly where these belong instead. */
const RAW_SELECTOR_METHODS = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByAltText",
  "getByTitle",
  "$",
  "$$",
  "$eval",
  "$$eval",
  "click",
  "dblclick",
  "tap",
  "fill",
  "selectOption",
  "check",
  "uncheck",
  "press",
  "type",
  "hover",
  "dragAndDrop",
  "setInputFiles",
  "selectText",
  "waitForSelector",
]);

const RECEIVER_NAMES = new Set(["page", "context", "frame"]);

/**
 * Finds every local identifier that is a plain alias of `page`/`context`/`frame` -- either through
 * destructuring-renaming a fixture parameter (`async ({ page: p }) => ...`) or a direct local
 * assignment (`const thePage = page;`) -- so the raw-selector/raw-screenshot/fixed-wait rules can't
 * be trivially defeated by the single most ordinary way a test author might rename one of these
 * (multi-page tests routinely destructure-rename `page` to something like `adminPage`/`guestPage`).
 * This is a file-scoped, best-effort heuristic (not real scope/type analysis): it iterates to a
 * fixed point so a short alias chain (`const p = page; const q = p;`) still resolves, and it errs
 * toward flagging more real receivers, matching every other rule in this file, which is itself a
 * deliberate heuristic rather than a full type checker.
 */
function collectReceiverAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>(RECEIVER_NAMES);
  let changed = true;
  while (changed) {
    changed = false;
    function visit(node: ts.Node): void {
      if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && !element.dotDotDotToken) {
            const sourceName =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            if (aliases.has(sourceName) && !aliases.has(element.name.text)) {
              aliases.add(element.name.text);
              changed = true;
            }
          }
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        aliases.has(node.initializer.text) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return aliases;
}

/** Finds an exception comment on `line` or the line immediately before it. `sourceLines` is the
 * full file split on "\n" (1-based access via `line - 1`). */
function findException(sourceLines: string[], line: number): LintException | undefined {
  for (const candidate of [line, line - 1]) {
    const text = sourceLines[candidate - 1];
    if (!text) continue;
    const match = EXCEPTION_COMMENT.exec(text);
    if (match) {
      return { rule: match[1] as LintRuleId | "*", line: candidate, rationale: match[2] };
    }
  }
  return undefined;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** True when `catchBlock` shows some form of meaningful handling (rethrow, an evidence attach, or
 * an assertion) rather than silently discarding the error -- spec 7.3: "Never catch and suppress
 * an assertion or navigation failure." Heuristic, not a full data-flow analysis: looks for a
 * `throw`, a call whose name contains "attach" (e.g. `testInfo.attach`), or an `expect(` call
 * anywhere within the catch block. */
function catchHandlesError(catchClause: ts.CatchClause): boolean {
  let handled = false;
  function visit(node: ts.Node): void {
    if (handled) return;
    if (ts.isThrowStatement(node)) {
      handled = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText();
      if (/\battach\b/i.test(calleeText) || /^expect\b/.test(calleeText) || /\.expect\b/.test(calleeText)) {
        handled = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(catchClause.block);
  return handled;
}

/** True when a `test.skip`/`.fixme`/`.fail` call carries a string-literal (or template-literal)
 * reason argument -- Playwright's own `(condition, reason)` / `(reason)` overloads already give a
 * place to record *why*, so a provided reason is itself the documentation Section 7.3's "avoid
 * conditional branches that allow the test to pass without validating its objective" and the
 * Stage 04 "unreasoned skip/fixme/fail" check are both really asking for. */
function hasReasonArgument(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (arg) => ts.isStringLiteralLike(arg) && arg.text.trim().length > 0,
  );
}

/** Counts `expect(...)` call sites anywhere within `node` (including nested `test.step` callbacks
 * and helper calls written inline) -- a crude but effective proxy for "this test's central
 * business validation is executed" (spec 7.3). */
function countExpectCalls(node: ts.Node): number {
  let count = 0;
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n)) {
      const text = n.expression.getText();
      if (text === "expect" || /(^|\.)expect$/.test(text) || /^expect\.poll$/.test(text)) {
        count++;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return count;
}

/** Runs every Stage 04 static rule against one test-file's source text. `fileName` is used only
 * for TypeScript's parser diagnostics context, not for any naming-convention check (that lives in
 * the CLI, which also has the file's on-disk path available). */
export function checkTestSource(fileName: string, sourceText: string): LintResult {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const sourceLines = sourceText.split("\n");
  const issues: LintIssue[] = [];
  const exceptionsUsed: LintException[] = [];
  const receiverAliases = collectReceiverAliases(sourceFile);

  function record(rule: LintRuleId, node: ts.Node, message: string): void {
    const line = lineOf(sourceFile, node);
    const exception = findException(sourceLines, line);
    if (exception && (exception.rule === rule || exception.rule === "*")) {
      exceptionsUsed.push({ ...exception, rule });
      return;
    }
    issues.push({ rule, line, message });
  }

  // Top-level "is this a test case?" call sites, so missing-assertion can be scoped per test
  // rather than "does the whole file contain expect() anywhere" (which would miss a test with
  // zero assertions sitting next to a sibling test that has plenty).
  const testCaseCalls: ts.CallExpression[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText();

      // test.only(...) / test.describe.only(...)
      if (/^test(\.describe)?\.only$/.test(calleeText)) {
        record("test-only", node, `"${calleeText}(...)" must never be committed -- it silently excludes every other test in the run.`);
      }

      // test.skip(...) / test.fixme(...) / test.fail(...) without a reason argument.
      if (/^test\.(skip|fixme|fail)$/.test(calleeText) && node.arguments.length > 0 && !hasReasonArgument(node)) {
        record(
          "unreasoned-skip",
          node,
          `"${calleeText}(...)" is used without a string reason -- pass a reason argument (Playwright supports it natively) or add a "pw-lint-exception" comment with a rationale.`,
        );
      }

      // Raw selector/action methods called directly on page/context/frame.
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const method = node.expression.name.text;
        if (ts.isIdentifier(receiver) && receiverAliases.has(receiver.text) && RAW_SELECTOR_METHODS.has(method)) {
          record(
            "raw-selector-in-test",
            node,
            `Raw "${receiver.text}.${method}(...)" call in a test file -- move this selector/action into a page or component object (spec Section 7.2).`,
          );
        }
        if (ts.isIdentifier(receiver) && receiverAliases.has(receiver.text) && method === "screenshot") {
          record(
            "raw-screenshot-in-test",
            node,
            `Raw "${receiver.text}.screenshot(...)" call -- successful-test screenshots must go through the named evidence helper (spec Section 7.4), not a direct screenshot call.`,
          );
        }
        if (
          ts.isIdentifier(receiver) &&
          receiverAliases.has(receiver.text) &&
          method === "waitForTimeout"
        ) {
          record(
            "fixed-wait",
            node,
            `Fixed "${receiver.text}.waitForTimeout(...)" call -- use Playwright's web-first assertions/auto-waiting instead of a fixed sleep (spec Section 7.3).`,
          );
        }
      }

      // Bare setTimeout(...) used as a sleep.
      if (ts.isIdentifier(node.expression) && node.expression.text === "setTimeout") {
        record("fixed-wait", node, `Bare "setTimeout(...)" call -- use Playwright's web-first assertions/auto-waiting instead of a fixed sleep (spec Section 7.3).`);
      }

      // Candidate test-case call: test(...)/defineQualityTest(...) whose last argument is a
      // function (the test body).
      if (/(^|\.)test$/.test(calleeText) || calleeText === "defineQualityTest") {
        const lastArg = node.arguments[node.arguments.length - 1];
        if (lastArg && (ts.isArrowFunction(lastArg) || ts.isFunctionExpression(lastArg))) {
          testCaseCalls.push(node);
        }
      }
    }

    if (ts.isCatchClause(node) && !catchHandlesError(node)) {
      record(
        "swallowed-error",
        node,
        `catch block does not rethrow, attach evidence, or assert -- an assertion/navigation failure must never be silently discarded (spec Section 7.3).`,
      );
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  for (const call of testCaseCalls) {
    const lastArg = call.arguments[call.arguments.length - 1] as ts.ArrowFunction | ts.FunctionExpression;
    if (countExpectCalls(lastArg.body) === 0) {
      record(
        "missing-assertion",
        call,
        `Test case has no "expect(...)" calls -- it can pass without executing its central business validation (spec Section 7.3).`,
      );
    }
  }

  return { issues, exceptionsUsed };
}
