// Stage 08 -- repair-write-guard.mjs, fully isolated: every test spawns the real script against a
// throwaway fake repository root (its own quality/repair-allowed-dirs.yaml, artifacts/playwright/
// repair-scope.json, and e2e/tests fixture file) via CLAUDE_PROJECT_DIR, rather than touching this
// real repo's own state -- so these tests can run alongside a real /pw-repair-test session without
// any risk of interfering with it.
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook, permissionDecision } from "./runHook.js";

let fakeRoot: string;

function write(relPath: string, content: string): void {
  const abs = join(fakeRoot, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, content);
}

test.beforeEach(() => {
  fakeRoot = mkdtempSync(join(tmpdir(), "repair-write-guard-"));
  write(
    "quality/repair-allowed-dirs.yaml",
    "schemaVersion: \"1.0.0\"\nallowedDirs:\n  - e2e/tests\n  - e2e/pages\n",
  );
  write("e2e/tests/existing.spec.ts", "// existing test fixture\n");
  write("e2e/pages/ExistingPage.ts", "// existing page object fixture\n");
});

test.afterEach(() => {
  rmSync(fakeRoot, { recursive: true, force: true });
});

function stdin(toolName: "Edit" | "Write", filePath: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath, ...extra }, cwd: fakeRoot });
}

// Stage 09: repair-write-guard.mjs's final check requires the most recent maintenance report
// (artifacts/playwright/maintenance/*.json) to contain a finding whose "Test source" evidence link
// names the file being edited, with repairAllowed: true -- every test below that expects an
// ultimate "allow" must provide one; every test that only exercises an EARLIER check (scope,
// symlink, diff-safety) intentionally does not, since those are expected to deny first anyway.
function writeMaintenanceReport(testSourceRelPath: string, repairAllowed: boolean): void {
  write(
    "artifacts/playwright/maintenance/report-1.json",
    JSON.stringify({
      schemaVersion: "1.0.0",
      reportId: "report-1",
      generatedAt: "2026-09-10T12:00:00.000Z",
      frameworkVersion: "0.9.0",
      sourceRunId: "run-1",
      findings: [
        {
          testId: "fixture.test",
          runId: "run-1",
          classification: repairAllowed ? "probable-test-defect" : "insufficient-evidence",
          confidence: "medium",
          expectedBehavior: "e",
          observedBehavior: "o",
          evidenceLinks: [{ label: "Test source (line 1)", path: testSourceRelPath }],
          comparisonNotes: "n",
          evidenceForApplicationDefect: [],
          evidenceAgainstApplicationDefect: [],
          evidenceForTestDefect: [],
          evidenceAgainstTestDefect: [],
          recommendedNextAction: "a",
          repairAllowed,
          repairAllowedFiles: repairAllowed ? [testSourceRelPath] : [],
          needsHumanReview: !repairAllowed,
          source: "mechanical",
        },
      ],
    }),
  );
}

test("allowed: editing an existing file that is both under an allowed directory and in the approved scope", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  writeMaintenanceReport("e2e/tests/existing.spec.ts", true);
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "existing test fixture", new_string: "existing test fixture, edited" }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(0);
  expect(permissionDecision(result)).toBe("allow");
});

test("denied: target path is outside every approved directory, even though it's in the scope file", () => {
  write("package.json", "{}");
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["package.json"] }));
  const result = runHook("repair-write-guard.mjs", stdin("Write", "package.json", { content: "{}" }), { CLAUDE_PROJECT_DIR: fakeRoot });
  expect(result.status).toBe(2);
  expect(permissionDecision(result)).toBe("deny");
  expect(result.stderr).toContain("outside the approved test-framework paths");
});

test("denied: target path is under an allowed directory but was never approved for this session (no scope file)", () => {
  const result = runHook("repair-write-guard.mjs", stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "a", new_string: "b" }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("no repair scope has been established");
});

test("denied: target path is under an allowed directory but a different file is the one actually approved", () => {
  write("e2e/tests/other.spec.ts", "// a second existing test\n");
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  const result = runHook("repair-write-guard.mjs", stdin("Edit", "e2e/tests/other.spec.ts", { old_string: "a", new_string: "b" }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("is not in this session's approved repair scope");
});

test("denied: Write would create a brand-new file, even one inside an allowed, approved path", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/brand-new.spec.ts"] }));
  const result = runHook("repair-write-guard.mjs", stdin("Write", "e2e/tests/brand-new.spec.ts", { content: "// new\n" }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("does not exist yet");
});

test("denied: quality/repair-allowed-dirs.yaml itself is missing (fails safe, not permissive)", () => {
  rmSync(join(fakeRoot, "quality/repair-allowed-dirs.yaml"));
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  const result = runHook("repair-write-guard.mjs", stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "a", new_string: "b" }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("repair-allowed-dirs.yaml does not exist");
});

test("malformed: stdin is not valid JSON at all", () => {
  const result = runHook("repair-write-guard.mjs", "not json at all", { CLAUDE_PROJECT_DIR: fakeRoot });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("malformed hook input");
});

test("malformed: repair-scope.json exists but is not valid JSON", () => {
  write("artifacts/playwright/repair-scope.json", "{ this is not json");
  const result = runHook("repair-write-guard.mjs", stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "a", new_string: "b" }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("is not valid JSON");
});

test("missing: tool_input.file_path is absent from an otherwise well-formed hook input", () => {
  const result = runHook("repair-write-guard.mjs", JSON.stringify({ tool_name: "Edit", tool_input: {} }), { CLAUDE_PROJECT_DIR: fakeRoot });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("file_path is missing");
});

test("denied: target is a symlink under an allowed, approved path that resolves outside every allowed directory (Stage 08 audit finding, fixed)", () => {
  // A symlink named exactly like a plain, allowed-directory test file, but that actually points at
  // an application-source file well outside every approved directory.
  mkdirSync(join(fakeRoot, "apps/web/src"), { recursive: true });
  writeFileSync(join(fakeRoot, "apps/web/src/foo.ts"), "export const x = 1;\n");
  symlinkSync(join(fakeRoot, "apps/web/src/foo.ts"), join(fakeRoot, "e2e/tests/symlinked.spec.ts"));
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/symlinked.spec.ts"] }));
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/symlinked.spec.ts", { old_string: "export const x = 1;", new_string: "export const x = 999; // HACKED" }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("is a symlink or contains one in its path");
  // Confirm the write genuinely never happened -- the real application-source file is untouched.
  expect(readFileSync(join(fakeRoot, "apps/web/src/foo.ts"), "utf-8")).toBe("export const x = 1;\n");
});

// --- Stage 09: diff-safety proxy (assessDiffRisk) -----------------------------------------------
// "Repair cannot broaden selectors, remove assertions, add sleeps, or skip a test without explicit
// justified review" (Section 09 acceptance criteria). Each risky category below is denied unless
// artifacts/playwright/repair-scope.json's justifiedExceptions names it with a non-empty reason.

test("denied: an edit that decreases the expect(...)/expect.poll(...) count is flagged (Stage 09 diff-safety proxy)", () => {
  write(
    "e2e/tests/risky.spec.ts",
    "test('t', async () => {\n  await expect(a).toBeVisible();\n  await expect(b).toBeVisible();\n});\n",
  );
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/risky.spec.ts"] }));
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Write", "e2e/tests/risky.spec.ts", {
      content: "test('t', async () => {\n  await expect(a).toBeVisible();\n});\n",
    }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("assertion-count-decrease");
});

test("allowed: assertion-count-decrease is allowed once justifiedExceptions names it with a real reason", () => {
  write(
    "e2e/tests/risky.spec.ts",
    "test('t', async () => {\n  await expect(a).toBeVisible();\n  await expect(b).toBeVisible();\n});\n",
  );
  write(
    "artifacts/playwright/repair-scope.json",
    JSON.stringify({
      approvedPaths: ["e2e/tests/risky.spec.ts"],
      justifiedExceptions: [{ category: "assertion-count-decrease", reason: "Human confirmed the second assertion was a duplicate of the first; safe to remove." }],
    }),
  );
  writeMaintenanceReport("e2e/tests/risky.spec.ts", true);
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Write", "e2e/tests/risky.spec.ts", {
      content: "test('t', async () => {\n  await expect(a).toBeVisible();\n});\n",
    }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(0);
  expect(permissionDecision(result)).toBe("allow");
});

test("denied: introducing a new .waitForTimeout(...) call is flagged even though no assertion changed", () => {
  write("e2e/tests/risky.spec.ts", "test('t', async () => {\n  await expect(a).toBeVisible();\n});\n");
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/risky.spec.ts"] }));
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/risky.spec.ts", {
      old_string: "test('t', async () => {\n  await expect(a).toBeVisible();\n});\n",
      new_string: "test('t', async () => {\n  await page.waitForTimeout(2000);\n  await expect(a).toBeVisible();\n});\n",
    }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("new-fixed-wait");
});

test("denied: introducing a new .skip(...) call is flagged", () => {
  write("e2e/tests/risky.spec.ts", "test('t', async () => {\n  await expect(a).toBeVisible();\n});\n");
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/risky.spec.ts"] }));
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/risky.spec.ts", {
      old_string: "test('t',",
      new_string: "test.skip('t',",
    }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("new-skip-only-or-fixme");
});

test("denied: introducing a new raw page.locator(...) call directly inside a test file is flagged", () => {
  write("e2e/tests/risky.spec.ts", "test('t', async () => {\n  await expect(a).toBeVisible();\n});\n");
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/risky.spec.ts"] }));
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/risky.spec.ts", {
      old_string: "await expect(a).toBeVisible();",
      new_string: "await expect(page.locator('.raw')).toBeVisible();",
    }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("new-raw-selector-in-test");
});

test("denied: ANY edit to a page/component object file is always flagged, even a comment-only change", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/pages/ExistingPage.ts"] }));
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/pages/ExistingPage.ts", {
      old_string: "// existing page object fixture",
      new_string: "// existing page object fixture (touched)",
    }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("page-object-or-component-change");
});

test("allowed: a page/component object edit is allowed once justifiedExceptions names page-object-or-component-change", () => {
  write(
    "artifacts/playwright/repair-scope.json",
    JSON.stringify({
      approvedPaths: ["e2e/pages/ExistingPage.ts"],
      justifiedExceptions: [{ category: "page-object-or-component-change", reason: "Human confirmed a stale locator needed updating, not a broadening." }],
    }),
  );
  writeMaintenanceReport("e2e/pages/ExistingPage.ts", true);
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/pages/ExistingPage.ts", {
      old_string: "// existing page object fixture",
      new_string: "// existing page object fixture (touched)",
    }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(0);
  expect(permissionDecision(result)).toBe("allow");
});

test("denied: a justifiedExceptions entry with an empty reason does not count as justified (fails safe)", () => {
  write("e2e/tests/risky.spec.ts", "test('t', async () => {\n  await expect(a).toBeVisible();\n  await expect(b).toBeVisible();\n});\n");
  write(
    "artifacts/playwright/repair-scope.json",
    JSON.stringify({
      approvedPaths: ["e2e/tests/risky.spec.ts"],
      justifiedExceptions: [{ category: "assertion-count-decrease", reason: "   " }],
    }),
  );
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Write", "e2e/tests/risky.spec.ts", { content: "test('t', async () => {\n  await expect(a).toBeVisible();\n});\n" }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("assertion-count-decrease");
});

// --- Stage 09: mechanical enforcement of the maintenance report's own repairAllowed verdict ------

test("denied: no maintenance report exists at all under artifacts/playwright/maintenance/", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "existing test fixture", new_string: "existing test fixture, edited" }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("no maintenance report exists");
});

test("denied: a maintenance report exists but no finding's test source names this file", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  writeMaintenanceReport("e2e/tests/some-other-test.spec.ts", true);
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "existing test fixture", new_string: "existing test fixture, edited" }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("contains no finding whose test source is");
});

test("denied: the matching finding's own repairAllowed is false (e.g. insufficient-evidence)", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  writeMaintenanceReport("e2e/tests/existing.spec.ts", false);
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "existing test fixture", new_string: "existing test fixture, edited" }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("repairAllowed: false");
  expect(result.stderr).toContain("insufficient-evidence");
});

test("denied: the most recent maintenance report file is not valid JSON (fails safe)", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  write("artifacts/playwright/maintenance/report-1.json", "{ not valid json");
  const result = runHook(
    "repair-write-guard.mjs",
    stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "existing test fixture", new_string: "existing test fixture, edited" }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("is not valid JSON");
});

test("ignores tool calls that aren't Edit or Write (defensive fallback)", () => {
  const result = runHook("repair-write-guard.mjs", JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(0);
});
