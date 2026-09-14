import { test, expect } from "@playwright/test";
import { countExcludedApplicationTests, stripAnsi, buildWhyExplanation } from "../reporting/normalizedReporter.js";
import type { DiscoveredApplicationTest } from "../validation/discoverAllTests.js";

// Stage 06 AUDIT FINDING (locking regression test): `countExcludedApplicationTests` reports how
// many real, tagged application tests were excluded by whatever selection launched this run
// (Section 10.2: "Selection summary and tests excluded by the filter"). The original implementation
// computed this as a raw count difference (`discoveredApplicationTests.length - allTestsThatRan`),
// which silently reports 0 excluded -- via `Math.max(0, ...)` clamping a negative number -- whenever
// an invocation also runs non-application tests (framework-health.spec.ts, unit/*.spec.ts, the whole
// framework-unit project) alongside a PARTIAL application-test selection, because the count of ALL
// tests that ran can exceed the total number of application tests even when a real application test
// was excluded. Reproduced live: `playwright test --project=chromium --project=framework-unit
// e2e/tests/guest-viewing.spec.ts e2e/tests/unit/ids.spec.ts` ran 1 of 2 real application tests
// (guest-management.spec.ts's test never ran) alongside 11 unrelated unit tests -- the buggy formula
// reported "0 excluded" for a run that in fact excluded a real application test. A future change
// that reverts to a raw-count difference must fail this test, not just an ad hoc live check.

function fakeApplicationTest(id: string): DiscoveredApplicationTest {
  return {
    metadata: {
      id,
      title: `synthetic test ${id}`,
      objective: "synthetic",
      expectedOutcome: "synthetic",
      tags: ["@readonly"],
      requirementIds: [],
    } as unknown as DiscoveredApplicationTest["metadata"],
    filePath: `e2e/tests/${id}.spec.ts`,
    line: 1,
  };
}

test.describe("countExcludedApplicationTests", () => {
  test("reports 0 excluded when every discovered application test ran, alongside unrelated non-application tests", () => {
    const discovered = [fakeApplicationTest("a"), fakeApplicationTest("b")];
    const ran = new Set(["a", "b", "unit-test-1", "unit-test-2", "framework-health-1"]);
    expect(countExcludedApplicationTests(discovered, ran)).toBe(0);
  });

  test("reports the real exclusion count even when many MORE non-application tests ran than were discovered -- the bug this test locks", () => {
    // Reproduces the live case: 2 discovered application tests, only 1 ran, but 11 unrelated
    // (non-application) tests also ran in the same invocation -- 12 tests ran in total, more than
    // the 2 discovered application tests, which is exactly what made the old raw-count-difference
    // formula go negative and clamp to a false "0 excluded".
    const discovered = [fakeApplicationTest("guest-viewing"), fakeApplicationTest("guest-management")];
    const ranManyUnrelated = new Set([
      "guest-viewing",
      "unit-1",
      "unit-2",
      "unit-3",
      "unit-4",
      "unit-5",
      "unit-6",
      "unit-7",
      "unit-8",
      "unit-9",
      "unit-10",
      "unit-11",
    ]);
    expect(ranManyUnrelated.size).toBeGreaterThan(discovered.length);
    expect(countExcludedApplicationTests(discovered, ranManyUnrelated)).toBe(1);
  });

  test("reports every discovered application test as excluded when none of them ran", () => {
    const discovered = [fakeApplicationTest("a"), fakeApplicationTest("b"), fakeApplicationTest("c")];
    expect(countExcludedApplicationTests(discovered, new Set())).toBe(3);
  });

  test("never returns a negative count", () => {
    const discovered = [fakeApplicationTest("a")];
    const ran = new Set(["a", "a-duplicate-somehow"]);
    expect(countExcludedApplicationTests(discovered, ran)).toBe(0);
  });

  test("returns 0 when discovery found nothing, rather than fabricating a count", () => {
    expect(countExcludedApplicationTests([], new Set(["x", "y"]))).toBe(0);
  });
});

// Stage 06 AUDIT FINDING (locking regression test): Playwright's own `TestResult.errors[].message`/
// `.stack` (and step errors) embed raw ANSI SGR escape codes for terminal coloring (e.g.
// `\x1b[2mexpect(\x1b[22m\x1b[31mreceived\x1b[39m...`). Before this fix, the reporter's `sanitize()`
// passed this straight through `redact()` with no ANSI handling, so every error message, sanitized
// stack trace, and "why this failed" summary in the run report carried literal escape-code garbage
// -- reproduced live during the Stage 06 audit by deliberately failing a real test and inspecting
// the generated run-report JSON: `errorMessage` and `whyFailed` both contained raw `[...m`
// sequences, not plain readable text. A future change that stops stripping ANSI before redaction
// must fail this test, not just an ad hoc live check.
test.describe("stripAnsi", () => {
  test("removes SGR color escape codes from a Playwright-style expect() diff", () => {
    const raw =
      "Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m\n\n" +
      'Expected: [32m"[7mEXPECTED[27m_VALUE"[39m\nReceived: [31m"[7mWRONG[27m_VALUE"[39m';
    const cleaned = stripAnsi(raw);
    expect(cleaned).toBe(
      'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "EXPECTED_VALUE"\nReceived: "WRONG_VALUE"',
    );
    expect(/\x1b/.test(cleaned)).toBe(false);
  });

  test("leaves plain text with no escape codes completely unchanged", () => {
    const plain = "Timeout 5000ms exceeded while waiting on the predicate";
    expect(stripAnsi(plain)).toBe(plain);
  });

  test("is idempotent: stripping already-clean text changes nothing further", () => {
    const raw = "[31mred text[39m";
    const once = stripAnsi(raw);
    expect(stripAnsi(once)).toBe(once);
  });
});

// Stage 06 AUDIT FINDING (locking regression test): `buildWhyExplanation` had no explicit branch
// for "skipped"/"quarantined" -- a test that never ran its body at all. Both fell through every
// earlier branch (not passing-like, not expected-failure, zero named steps so no "first failing
// step", not setup-failure, not timeout) and hit the final catch-all: `{ whyFailed: "Failed, but no
// specific failing named step was recorded." }` -- actively false for a test that was deliberately
// never executed via `test.skip()`/`test.fixme()`, or skipped-and-tagged `@quarantined`. Reproduced
// live during the Stage 06 audit with a real `test.skip()`-tagged `@quarantined` test: the generated
// run-report JSON claimed the test had "Failed" when it had, in fact, never run. A future change
// that reintroduces that fallthrough must fail this test, not just an ad hoc live check.
test.describe("buildWhyExplanation", () => {
  test("a skipped test gets neither a why-passed nor a why-failed explanation -- it never ran, so it neither passed nor failed", () => {
    const result = buildWhyExplanation("skipped", [], 0);
    expect(result.whyPassed).toBeUndefined();
    expect(result.whyFailed).toBeUndefined();
  });

  test("a quarantined test gets neither a why-passed nor a why-failed explanation, for the same reason", () => {
    const result = buildWhyExplanation("quarantined", [], 0);
    expect(result.whyPassed).toBeUndefined();
    expect(result.whyFailed).toBeUndefined();
  });

  test("an ordinary consistent failure with no named steps still gets a why-failed explanation (the skipped/quarantined check does not swallow real failures)", () => {
    const result = buildWhyExplanation("consistent-failure", [], 0);
    expect(result.whyFailed).toBe("Failed, but no specific failing named step was recorded.");
  });
});
