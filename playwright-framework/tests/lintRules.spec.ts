import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkTestSource } from "../validation/lintRules.js";
import * as bad from "./fixtures/badPatternSnippets.js";

function rulesFound(source: string): string[] {
  return checkTestSource("fixture.spec.ts", source).issues.map((i) => i.rule);
}

test.describe("checkTestSource — catches every intentionally bad pattern", () => {
  test("raw selector call on page in a test file", () => {
    expect(rulesFound(bad.RAW_SELECTOR_IN_TEST)).toContain("raw-selector-in-test");
  });

  test("raw selector call on a destructure-renamed page (`{ page: p }`) is still caught (Stage 04 audit finding)", () => {
    expect(rulesFound(bad.RAW_SELECTOR_VIA_RENAMED_PAGE)).toContain("raw-selector-in-test");
  });

  test("raw selector call via a local alias (`const thePage = page`) is still caught (Stage 04 audit finding)", () => {
    expect(rulesFound(bad.RAW_SELECTOR_VIA_LOCAL_ALIAS)).toContain("raw-selector-in-test");
  });

  test("raw page.screenshot() in a test file", () => {
    expect(rulesFound(bad.RAW_SCREENSHOT_IN_TEST)).toContain("raw-screenshot-in-test");
  });

  test("fixed page.waitForTimeout()", () => {
    expect(rulesFound(bad.FIXED_WAIT_IN_TEST)).toContain("fixed-wait");
  });

  test("test.only", () => {
    expect(rulesFound(bad.TEST_ONLY)).toContain("test-only");
  });

  test("test.skip without a reason", () => {
    expect(rulesFound(bad.UNREASONED_SKIP)).toContain("unreasoned-skip");
  });

  test("test.skip WITH a reason is not flagged", () => {
    expect(rulesFound(bad.REASONED_SKIP_OK)).not.toContain("unreasoned-skip");
  });

  test("a catch block that only logs and swallows the error", () => {
    expect(rulesFound(bad.SWALLOWED_ERROR)).toContain("swallowed-error");
  });

  test("a catch block that attaches evidence and rethrows is not flagged", () => {
    expect(rulesFound(bad.RETHROWN_ERROR_OK)).not.toContain("swallowed-error");
  });

  test("a test with zero expect() calls", () => {
    expect(rulesFound(bad.MISSING_ASSERTION)).toContain("missing-assertion");
  });
});

test.describe("checkTestSource — exception mechanism", () => {
  test("a pw-lint-exception comment suppresses the named rule and is reported as a used exception", () => {
    const result = checkTestSource("fixture.spec.ts", bad.EXCEPTION_COMMENT_SUPPRESSES_RULE);
    expect(result.issues.some((i) => i.rule === "fixed-wait")).toBe(false);
    expect(result.exceptionsUsed).toHaveLength(1);
    expect(result.exceptionsUsed[0].rule).toBe("fixed-wait");
    expect(result.exceptionsUsed[0].rationale).toContain("2s animation");
  });

  test("an exception comment for a DIFFERENT rule does not suppress this one", () => {
    const source = bad.FIXED_WAIT_IN_TEST.replace(
      "await page.waitForTimeout(5000);",
      '// pw-lint-exception: test-only -- unrelated rule, should not suppress fixed-wait\n  await page.waitForTimeout(5000);',
    );
    const result = checkTestSource("fixture.spec.ts", source);
    expect(result.issues.some((i) => i.rule === "fixed-wait")).toBe(true);
    expect(result.exceptionsUsed).toHaveLength(0);
  });
});

test.describe("checkTestSource — no false positives", () => {
  test("a clean, well-formed test produces zero issues", () => {
    const result = checkTestSource("fixture.spec.ts", bad.CLEAN_TEST);
    expect(result.issues).toEqual([]);
  });

  test("the real Stage 03/04 reference tests produce zero issues", () => {
    for (const relativePath of [
      "../../e2e/tests/guest-management.spec.ts",
      "../../e2e/tests/guest-viewing.spec.ts",
    ]) {
      const filePath = resolve(__dirname, relativePath);
      const source = readFileSync(filePath, "utf-8");
      const result = checkTestSource(filePath, source);
      expect(result.issues, `${relativePath} should have zero lint issues, got: ${JSON.stringify(result.issues)}`).toEqual(
        [],
      );
    }
  });
});
