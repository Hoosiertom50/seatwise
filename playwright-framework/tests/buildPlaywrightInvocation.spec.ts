import { test, expect } from "@playwright/test";
import { buildPlaywrightTestArgs } from "../runner/buildPlaywrightInvocation.js";

test.describe("buildPlaywrightTestArgs", () => {
  test("includes --project, --grep, and the matched files' own spec paths", () => {
    const args = buildPlaywrightTestArgs({
      compiledPattern: "^(?=.*@readonly(?![A-Za-z0-9:_-]))",
      matchedFilePaths: ["e2e/tests/guest-viewing.spec.ts"],
    });
    expect(args).toEqual([
      "exec",
      "playwright",
      "test",
      "--project=chromium",
      "--grep",
      "^(?=.*@readonly(?![A-Za-z0-9:_-]))",
      "e2e/tests/guest-viewing.spec.ts",
    ]);
  });

  // Stage 05 AUDIT FINDING (locking regression test): the whole point of passing matched files is
  // to keep an UNRELATED, untagged spec file (e.g. framework-health.spec.ts, which carries no tags
  // at all) out of the spawned invocation even when the compiled --grep pattern would otherwise be
  // satisfied by its bare, tagless title (true of any expression built on NOT, verified live: "NOT
  // @quarantined" matched 37 tests under --grep alone vs. the 2 real tests preview reported). A
  // future change that drops this restriction and reverts to --grep-only selection must fail this
  // test, not just an ad hoc live check.
  test("never includes a file outside the matched set, regardless of what --grep alone would match", () => {
    const args = buildPlaywrightTestArgs({
      compiledPattern: "^(?!(?=.*@quarantined(?![A-Za-z0-9:_-])))", // "NOT @quarantined"
      matchedFilePaths: ["e2e/tests/guest-management.spec.ts", "e2e/tests/guest-viewing.spec.ts"],
    });
    const fileArgs = args.filter((a) => a.endsWith(".spec.ts"));
    expect(fileArgs.sort()).toEqual(
      ["e2e/tests/guest-management.spec.ts", "e2e/tests/guest-viewing.spec.ts"].sort(),
    );
    expect(args).not.toContain("e2e/tests/framework-health.spec.ts");
    expect(args.some((a) => a.includes("unit/"))).toBe(false);
  });

  test("de-duplicates a spec file matched by more than one test in it", () => {
    const args = buildPlaywrightTestArgs({
      compiledPattern: "^(?=.*@feature:guests(?![A-Za-z0-9:_-]))",
      matchedFilePaths: ["e2e/tests/guest-management.spec.ts", "e2e/tests/guest-management.spec.ts"],
    });
    const fileArgs = args.filter((a) => a.endsWith(".spec.ts"));
    expect(fileArgs).toEqual(["e2e/tests/guest-management.spec.ts"]);
  });

  test("forwards --workers, --repeat-each, and --reporter only when provided", () => {
    const withNone = buildPlaywrightTestArgs({
      compiledPattern: "^(?=.*@readonly(?![A-Za-z0-9:_-]))",
      matchedFilePaths: ["e2e/tests/guest-viewing.spec.ts"],
    });
    expect(withNone).not.toContain("--workers");
    expect(withNone).not.toContain("--repeat-each");
    expect(withNone).not.toContain("--reporter");

    const withAll = buildPlaywrightTestArgs({
      compiledPattern: "^(?=.*@readonly(?![A-Za-z0-9:_-]))",
      matchedFilePaths: ["e2e/tests/guest-viewing.spec.ts"],
      workers: 2,
      repeatEach: 3,
      reporter: "list",
    });
    expect(withAll).toEqual(
      expect.arrayContaining(["--workers", "2", "--repeat-each", "3", "--reporter", "list"]),
    );
  });
});
