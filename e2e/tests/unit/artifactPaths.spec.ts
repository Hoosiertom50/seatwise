/**
 * Stage 03 — unit tests for e2e/support/artifactPaths.ts (spec Section 7.4 / Stage 03 task:
 * "Ensure artifact paths are unique across projects, workers, retries, and test IDs"). Uses a
 * minimal hand-built stand-in for Playwright's `TestInfo` rather than a real one, since the only
 * behavior under test is this module's own slugify + delegate-to-outputPath logic, not
 * `outputPath()` itself (which is Playwright's own, already-relied-upon guarantee -- see this
 * module's top-of-file comment).
 */

import { test, expect } from "@playwright/test";
import { slugifyArtifactName, artifactPath } from "../../support/artifactPaths.js";
import type { TestInfo } from "@playwright/test";

function fakeTestInfo(): TestInfo {
  const calls: string[] = [];
  return {
    outputPath: (...parts: string[]) => {
      const joined = parts.join("/");
      calls.push(joined);
      return `/fake/test-results/some-test-dir/${joined}`;
    },
    // The rest of TestInfo is unused by artifactPath -- cast rather than fill in ~40 unused fields.
  } as unknown as TestInfo;
}

test.describe("slugifyArtifactName", () => {
  test("lowercases and hyphenates spaces", () => {
    expect(slugifyArtifactName("Guest Added")).toBe("guest-added");
  });

  test("collapses runs of unsafe characters into a single hyphen", () => {
    expect(slugifyArtifactName("guest / added !! (final)")).toBe("guest-added-final");
  });

  test("strips leading and trailing hyphens produced by leading/trailing unsafe characters", () => {
    expect(slugifyArtifactName("  --guest-added--  ")).toBe("guest-added");
  });

  test("preserves digits and existing hyphens", () => {
    expect(slugifyArtifactName("guest-42-added")).toBe("guest-42-added");
  });

  test("a name with only unsafe characters slugifies to an empty string", () => {
    expect(slugifyArtifactName("!!!")).toBe("");
  });
});

test.describe("artifactPath", () => {
  test("builds a path from the slugified name and extension, delegating to testInfo.outputPath", () => {
    const testInfo = fakeTestInfo();
    const path = artifactPath(testInfo, "Guest Added", "png");
    expect(path).toBe("/fake/test-results/some-test-dir/guest-added.png");
  });

  test("strips a leading dot from the extension so callers can pass either 'png' or '.png'", () => {
    const testInfo = fakeTestInfo();
    expect(artifactPath(testInfo, "checkpoint", ".png")).toBe(
      artifactPath(fakeTestInfo(), "checkpoint", "png"),
    );
  });

  test("throws a descriptive error rather than silently writing an empty filename when the name slugifies to nothing", () => {
    const testInfo = fakeTestInfo();
    expect(() => artifactPath(testInfo, "!!!", "png")).toThrow(/empty slug/);
  });

  test("two different checkpoint names never collide within the same test", () => {
    const testInfo = fakeTestInfo();
    const a = artifactPath(testInfo, "guest-added", "png");
    const b = artifactPath(testInfo, "guest-removed", "png");
    expect(a).not.toBe(b);
  });
});
