/**
 * Stage 06 — a custom Playwright reporter (spec Section 10.2) that writes one normalized,
 * schema-validated `RunReport` JSON document per run to
 * `artifacts/playwright/runs/run-reports/<runId>.json`, then renders it to a self-contained HTML
 * report at `<runId>.html` in the same directory. Registered in `playwright.config.ts` alongside
 * the native `list`/`html` reporters (Section 10.2 task: "Configure Playwright's native HTML
 * reporter as a diagnostic companion" -- this reporter supplements it, never replaces it).
 *
 * Everything this reporter records comes directly from Playwright's own `TestCase`/`TestResult`/
 * `TestStep` objects -- never re-parsed from source or guessed. In particular:
 *  - Governed metadata (objective, expectedOutcome, requirementIds) is read back from the
 *    `annotation` entries `defineQualityTest` (Stage 02/03) already attaches to every real test,
 *    not re-discovered via AST parsing -- the reporter runs inside the same process that already
 *    has this data live on the TestCase object.
 *  - `assertionCount` is a count of `expect`-category `TestStep`s Playwright itself recorded as
 *    having actually run (Section 10.1: "every claimed successful validation is backed by an
 *    executed assertion") -- never inferred from source text.
 *  - Every string that could contain user data (error messages, stack traces, console/network
 *    diagnostics) is passed through the same `redact()` this framework already uses for other
 *    evidence (e2e/support/redaction.ts), and every absolute path is rewritten relative to the
 *    repo root before it is ever written to the report (Section 10.1: "contains no absolute path
 *    unless configured for local editor linking" -- this framework has none configured, DEC-004).
 *
 * Status classification (spec Section 10.2's required categories) is derived from Playwright's own
 * `TestCase.outcome()` and the final `TestResult.status`, plus this repo's own `@quarantined` tag
 * convention (quality/tag-taxonomy.yaml) -- documented per case in `classifyOutcome` below.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type {
  Reporter,
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { redact } from "../../e2e/support/redaction.js";
import { discoverAllApplicationTests } from "../validation/discoverAllTests.js";
import {
  RunReportSchema,
  type RunReport,
  type RunReportTest,
  type StepOutcome,
} from "../metadata/schemas.js";
import { renderRunReportHtml } from "./renderRunReportHtml.js";
import { REPORT_DIR } from "./constants.js";

function toRepoRelative(rootDir: string, absPath: string | undefined): string | undefined {
  if (!absPath) return undefined;
  const rel = relative(rootDir, absPath);
  // Never leak an absolute path even for something outside rootDir (shouldn't normally happen,
  // but "fail safe rather than leak a path" beats a guaranteed-relative assumption).
  return rel.startsWith("..") ? undefined : rel;
}

// Playwright's own `TestResult.errors[].message`/`.stack` (and step errors) are terminal-oriented
// text: they embed raw ANSI SGR escape codes (`\x1b[2m`, `\x1b[31m`, ...) for coloring the
// "Expected"/"Received" diff when printed to a real terminal. Left in place, that raw escape text
// survives into the report JSON/HTML verbatim -- a browser doesn't render it as color, it just
// leaves the literal control characters sitting in the text, corrupting both the visible "why this
// failed" plain-language summary and a copy-paste of the error message. Stripped here rather than
// in the shared `redact()` (e2e/support/redaction.ts): that function's job is credential redaction
// for evidence generally, not Playwright's own terminal-formatting choices, which are specific to
// this reporter's own error/stack-trace/step-error fields.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function sanitize(text: string, rootDir: string): string {
  const withoutAnsi = stripAnsi(text);
  const withoutSecrets = redact(withoutAnsi);
  // Absolute paths under the repo root are rewritten relative; anything else is left alone (it's
  // already been through redact() for credential-shaped content).
  return withoutSecrets.split(rootDir + "/").join("");
}

function annotationValue(test: TestCase, type: string): string | undefined {
  return test.annotations.find((a) => a.type === type)?.description;
}

/** Flattens every `expect`-category step anywhere in the tree (steps nest under `test.step`
 * blocks) -- a count of assertions Playwright itself recorded as executed. */
function countExpectSteps(steps: TestStep[]): number {
  let count = 0;
  for (const step of steps) {
    if (step.category === "expect") count++;
    count += countExpectSteps(step.steps);
  }
  return count;
}

/** Flattens every `test.step`-category step anywhere in the tree, in document order -- this
 * repo's own Arrange/Act/Assert convention (PLAYWRIGHT_TESTING.md), regardless of nesting depth. */
function collectNamedSteps(steps: TestStep[], rootDir: string): StepOutcome[] {
  const result: StepOutcome[] = [];
  for (const step of steps) {
    if (step.category === "test.step") {
      result.push({
        title: step.title,
        category: step.category,
        durationMs: step.duration,
        status: step.error ? "failed" : "passed",
        error: step.error?.message ? sanitize(step.error.message, rootDir) : undefined,
      });
    }
    result.push(...collectNamedSteps(step.steps, rootDir));
  }
  return result;
}

type RunStatus = RunReportTest["status"];

/**
 * Classifies a finished test into one of Section 10.2's required categories.
 *  - `skipped` test.skip()/fixme(), or a conditional skip -- `quarantined` when additionally
 *    tagged `@quarantined` (this repo's documented, not-yet-enforced convention for a deliberately
 *    disabled-but-tracked test -- quality/tag-taxonomy.yaml).
 *  - `timeout` when the final result's own status is `timedOut`.
 *  - `expected-failure` when the test used `test.fail()` and failed as expected
 *    (`test.outcome() === "expected"` with a `failed` result status).
 *  - `retry-pass` when Playwright's own `outcome()` says `"flaky"` -- it failed at least once but
 *    the FINAL attempt passed.
 *  - `initial-pass` the plain, ordinary case: passed on its first attempt.
 *  - `setup-failure` a heuristic, not a certainty (disclosed as such): a failure with zero of the
 *    test's own named `test.step`s recorded at all suggests the failure happened before the test
 *    body's own Arrange/Act/Assert steps ever ran -- most consistent with a fixture/hook problem
 *    rather than the test's own assertions. Every other failure is `consistent-failure`.
 *  - `interrupted` (Playwright's own fifth `TestResult.status`, alongside passed/failed/timedOut/
 *    skipped -- e.g. a worker process crashed, or the whole run was cancelled with Ctrl+C mid-test)
 *    is deliberately folded into `setup-failure` rather than silently falling through into whatever
 *    the final `if` happened to return: this repo's 8 categories (Section 10.2) have no dedicated
 *    "interrupted" bucket, and an interrupted test never reached its own pass/fail determination at
 *    all -- the closest honest fit is "not the test's own assertions," same as `setup-failure`.
 */
function classifyOutcome(test: TestCase, result: TestResult, namedSteps: StepOutcome[]): RunStatus {
  if (result.status === "skipped") {
    return test.tags.includes("@quarantined") ? "quarantined" : "skipped";
  }
  if (result.status === "timedOut") return "timeout";
  if (result.status === "interrupted") return "setup-failure";
  const outcome = test.outcome();
  if (outcome === "expected" && result.status === "failed") return "expected-failure";
  if (outcome === "flaky") return "retry-pass";
  if (result.status === "passed") return "initial-pass";
  // result.status === "failed" (and not expected-failure/flaky/timeout/interrupted, handled above)
  if (namedSteps.length === 0) return "setup-failure";
  return "consistent-failure";
}

export function buildWhyExplanation(status: RunStatus, namedSteps: StepOutcome[], assertionCount: number): {
  whyPassed?: string;
  whyFailed?: string;
} {
  // A skipped/quarantined test never ran its body at all -- it neither passed nor failed, so
  // neither field is set here. Without this explicit check, both statuses fell through every
  // branch below (zero named steps, not expected-failure/setup-failure/timeout) and hit the final
  // catch-all, which claims "Failed, but no specific failing named step was recorded" -- actively
  // false for a test that was deliberately never executed. Reproduced live during the Stage 06
  // audit with a real `test.skip()`-tagged `@quarantined` test.
  if (status === "skipped" || status === "quarantined") {
    return {};
  }
  const passingLike = status === "initial-pass" || status === "retry-pass" || status === "expected-failure";
  if (passingLike && status !== "expected-failure") {
    if (assertionCount === 0) {
      return {
        whyPassed:
          "Passed, but recorded zero executed assertions -- this is visible here rather than " +
          "silently counted as a validated pass (Section 10.1: a claimed success must be backed " +
          "by an executed assertion).",
      };
    }
    const stepNote = namedSteps.length > 0 ? ` across ${namedSteps.length} named step(s)` : "";
    return {
      whyPassed: `Passed because all ${assertionCount} recorded assertion(s)${stepNote} succeeded.`,
    };
  }
  if (status === "expected-failure") {
    return { whyPassed: "Marked test.fail() and failed as expected -- this is the intended outcome." };
  }
  const firstFailingStep = namedSteps.find((s) => s.status === "failed");
  if (firstFailingStep) {
    return {
      whyFailed: `Failed during the "${firstFailingStep.title}" step${
        firstFailingStep.error ? `: ${firstFailingStep.error}` : ""
      }.`,
    };
  }
  if (status === "setup-failure") {
    return {
      whyFailed:
        "Failed before any of the test's own named steps ran -- most consistent with a fixture, " +
        "hook, or environment problem rather than the test's own assertions (best-effort " +
        "classification, not a certainty).",
    };
  }
  if (status === "timeout") {
    return { whyFailed: "Did not complete within the configured timeout." };
  }
  return { whyFailed: "Failed, but no specific failing named step was recorded." };
}

/**
 * "Tests excluded by the filter" (Section 10.2): counts real, tagged application tests that were
 * statically discovered but did NOT run in this invocation -- matched by identity (`testId`), never
 * by subtracting raw counts of two differently-scoped sets.
 *
 * A raw-count subtraction (`discoveredApplicationTests.length - ranTestIds.size`) is wrong whenever
 * this invocation also ran non-application tests (framework-health.spec.ts, `unit/*.spec.ts`, the
 * whole `framework-unit` project) alongside a PARTIAL application-test selection: `ranTestIds.size`
 * then counts every test that ran, of every kind, which can exceed the total number of application
 * tests even though a real application test was excluded -- silently clamped to zero by
 * `Math.max(0, ...)`, hiding a genuine exclusion rather than reporting it.
 *
 * Reproduced live during the Stage 06 audit: `playwright test --project=chromium
 * --project=framework-unit e2e/tests/guest-viewing.spec.ts e2e/tests/unit/ids.spec.ts` ran 1 of the
 * 2 real application tests (guest-management.spec.ts's test never ran) alongside 11 unrelated unit
 * tests -- 12 tests ran in total, so the old formula (`2 discovered - 12 ran`, clamped) reported
 * "0 excluded" for a run that in fact excluded a real application test.
 */
export function countExcludedApplicationTests(
  discoveredApplicationTests: ReturnType<typeof discoverAllApplicationTests>["tests"],
  ranTestIds: ReadonlySet<string>,
): number {
  if (discoveredApplicationTests.length === 0) return 0; // discovery found/returned nothing -- best-effort, never fabricate a count
  const ranApplicationTestCount = discoveredApplicationTests.filter((t) =>
    ranTestIds.has(t.metadata.id),
  ).length;
  return Math.max(0, discoveredApplicationTests.length - ranApplicationTestCount);
}

export default class NormalizedReporter implements Reporter {
  private rootDir = process.cwd();
  private runId = process.env.PW_RUN_ID || randomUUID();
  private tagExpression = process.env.PW_RUN_TAG_EXPRESSION || "";
  private startedAt = new Date();
  private config: FullConfig | undefined;
  private suite: Suite | undefined;
  private byTestId = new Map<string, { test: TestCase; result: TestResult }>();

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
    this.rootDir = config.rootDir || process.cwd();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // May fire once per attempt (retries) for the same test -- the last call before onEnd holds
    // the final attempt, which is what we want to report.
    this.byTestId.set(test.id, { test, result });
  }

  async onEnd(result: FullResult): Promise<void> {
    if (!this.config) return; // onBegin never ran (e.g. a config error) -- nothing to report

    const rootDir = this.rootDir;
    const endedAt = new Date();

    let gitCommit = "unknown";
    try {
      gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir }).toString().trim();
    } catch {
      // no git available -- recorded as "unknown", never fabricated
    }
    let workingTreeClean = true;
    try {
      workingTreeClean =
        execFileSync("git", ["status", "--porcelain"], { cwd: rootDir }).toString().trim().length === 0;
    } catch {
      workingTreeClean = true; // unknown treated as clean rather than falsely flagging dirty
    }

    let playwrightVersion = this.config.version || "unknown";

    const counts = {
      initialPass: 0,
      retryPass: 0,
      consistentFailure: 0,
      timeout: 0,
      skipped: 0,
      expectedFailure: 0,
      quarantined: 0,
      setupFailure: 0,
    };

    // Every `defineQualityTest`-wrapped test's own `TestCase.location` resolves to wherever
    // Playwright's collector saw `test()` textually invoked -- which, for a test built through the
    // wrapper (playwright-framework/metadata/defineQualityTest.ts), is the wrapper's own internal
    // `testFn(...)` call site, not the real spec file the test author actually wrote it in. Cross-
    // referencing this discovery walk's own AST-derived file/line data (keyed by the test's own
    // declared `id`, the same id read back via the `quality-test-id` annotation below) recovers the
    // true location. Tests that don't go through the wrapper at all (framework-health.spec.ts,
    // unit/*.spec.ts) have no entry here and keep their already-correct `test.location` as a
    // fallback. Best-effort: if discovery throws for any reason, every test just falls back to its
    // (wrapper-attributed, for defineQualityTest tests) `test.location` rather than failing the
    // whole report.
    const trueLocationByTestId = new Map<string, { filePath: string; line: number }>();
    let discoveredApplicationTests: ReturnType<typeof discoverAllApplicationTests>["tests"] = [];
    try {
      discoveredApplicationTests = discoverAllApplicationTests(resolve(rootDir, "e2e/tests")).tests;
      for (const discovered of discoveredApplicationTests) {
        trueLocationByTestId.set(discovered.metadata.id, {
          filePath: discovered.filePath,
          line: discovered.line,
        });
      }
    } catch {
      // Discovery is best-effort here too (see the totalApplicationTests computation below, which
      // reuses this same walk) -- never fail report generation over it.
    }

    const tests: RunReportTest[] = [];

    for (const { test, result: testResult } of this.byTestId.values()) {
      const namedSteps = collectNamedSteps(testResult.steps, rootDir);
      const assertionCount = countExpectSteps(testResult.steps);
      const status = classifyOutcome(test, testResult, namedSteps);

      switch (status) {
        case "initial-pass":
          counts.initialPass++;
          break;
        case "retry-pass":
          counts.retryPass++;
          break;
        case "consistent-failure":
          counts.consistentFailure++;
          break;
        case "timeout":
          counts.timeout++;
          break;
        case "skipped":
          counts.skipped++;
          break;
        case "expected-failure":
          counts.expectedFailure++;
          break;
        case "quarantined":
          counts.quarantined++;
          break;
        case "setup-failure":
          counts.setupFailure++;
          break;
      }

      const successCheckpoints: RunReportTest["successCheckpoints"] = [];
      let failureScreenshotPath: string | undefined;
      let tracePath: string | undefined;
      let videoPath: string | undefined;
      let consoleMessages: string | undefined;
      let failedNetworkRequests: string | undefined;
      const checkpointValidationByName = new Map<string, string>();

      for (const attachment of testResult.attachments) {
        const relPath = toRepoRelative(rootDir, attachment.path);
        if (attachment.name.startsWith("checkpoint: ") && attachment.name.endsWith(" — validation")) {
          const name = attachment.name.slice("checkpoint: ".length, -" — validation".length);
          checkpointValidationByName.set(
            name,
            attachment.body ? sanitize(attachment.body.toString("utf-8"), rootDir) : "(no description)",
          );
          continue;
        }
        if (attachment.name.startsWith("checkpoint: ")) {
          const name = attachment.name.slice("checkpoint: ".length);
          successCheckpoints.push({
            name,
            screenshotPath: relPath,
            validationDescription: checkpointValidationByName.get(name) ?? "(pending)",
          });
          continue;
        }
        if (attachment.name === "console-messages") {
          consoleMessages = attachment.body ? sanitize(attachment.body.toString("utf-8"), rootDir) : undefined;
          continue;
        }
        if (attachment.name === "failed-network-requests") {
          failedNetworkRequests = attachment.body
            ? sanitize(attachment.body.toString("utf-8"), rootDir)
            : undefined;
          continue;
        }
        if (attachment.name === "screenshot") {
          failureScreenshotPath = relPath;
          continue;
        }
        if (attachment.name === "trace") {
          tracePath = relPath;
          continue;
        }
        if (attachment.name === "video") {
          videoPath = relPath;
          continue;
        }
      }
      // Reconcile checkpoints whose validation-description attachment (if any) was processed
      // after the screenshot attachment (attachment order is not guaranteed).
      for (const checkpoint of successCheckpoints) {
        const description = checkpointValidationByName.get(checkpoint.name);
        if (description) checkpoint.validationDescription = description;
      }

      const firstError = testResult.errors[0];
      const errorMessage = firstError?.message ? sanitize(firstError.message, rootDir) : undefined;
      const sanitizedStackTrace = firstError?.stack ? sanitize(firstError.stack, rootDir) : undefined;

      const { whyPassed, whyFailed } = buildWhyExplanation(status, namedSteps, assertionCount);

      const testId = annotationValue(test, "quality-test-id") ?? test.id;
      const trueLocation = trueLocationByTestId.get(testId);
      const filePath = trueLocation
        ? (toRepoRelative(rootDir, trueLocation.filePath) ?? trueLocation.filePath)
        : (toRepoRelative(rootDir, test.location.file) ?? test.location.file);
      const line = trueLocation ? trueLocation.line : test.location.line;

      tests.push({
        testId,
        title: test.title,
        filePath,
        line,
        tags: test.tags,
        requirementIds: (annotationValue(test, "requirement-ids") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        objective: annotationValue(test, "objective"),
        expectedOutcome: annotationValue(test, "expected-outcome"),
        status,
        durationMs: testResult.duration,
        attempts: test.results.length,
        steps: namedSteps,
        assertionCount,
        errorMessage,
        sanitizedStackTrace,
        successCheckpoints,
        failureScreenshotPath,
        tracePath,
        videoPath,
        consoleMessages,
        failedNetworkRequests,
        whyPassed,
        whyFailed,
      });
    }

    // "Tests excluded by the filter": every real, tagged application test this repo has, minus
    // however many of THOSE SAME tests actually ran in this invocation -- matched by identity
    // (testId), not by a raw count difference. Reuses the same discovery walk performed above for
    // location correction, rather than discovering twice.
    const matchedIds = new Set(tests.map((t) => t.testId));
    const excludedCount = countExcludedApplicationTests(discoveredApplicationTests, matchedIds);

    const report: RunReport = RunReportSchema.parse({
      schemaVersion: "1.0.0",
      runId: this.runId,
      generatedAt: new Date().toISOString(),
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: result.duration,
      initiator: process.env.PW_RUN_INITIATOR || "playwright test CLI",
      environment: process.env.CI ? "ci" : "local",
      baseUrl: process.env.APP_URL || "http://localhost:3000",
      gitCommit,
      workingTreeClean,
      playwrightVersion,
      nodeVersion: process.version,
      operatingSystem: `${os.platform()} ${os.release()}`,
      browserProjects: [...new Set(this.suite?.allTests().map((t) => t.parent.project()?.name ?? "unknown"))],
      workers: this.config.workers,
      retries: Math.max(0, ...this.config.projects.map((p) => p.retries ?? 0)),
      tagExpression: this.tagExpression,
      selectionSummary: { matchedCount: matchedIds.size, excludedCount },
      counts,
      tests,
      nativeReportPath: "../html-report/index.html",
    });

    const outDir = resolve(rootDir, REPORT_DIR);
    mkdirSync(outDir, { recursive: true });
    const jsonPath = resolve(outDir, `${this.runId}.json`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

    try {
      const html = renderRunReportHtml(report);
      writeFileSync(resolve(outDir, `${this.runId}.html`), html, "utf-8");
    } catch (err) {
      // Section 10.1: "Fail report generation visibly when required data is invalid" -- and
      // Stage 06's own acceptance criterion: "Report generation errors cause a nonzero result
      // without erasing raw Playwright output." The JSON above is already written; Playwright's
      // own list/html reporters have already produced their own output regardless of this
      // failure. We surface the error loudly and mark this reporter's own contribution failed,
      // without touching anything else.
      // eslint-disable-next-line no-console
      console.error(
        `\nRun-report HTML generation failed (the JSON at ${relative(rootDir, jsonPath)} was still written):\n` +
          `${err instanceof Error ? err.stack || err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
