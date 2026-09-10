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

test("allowed: editing an existing file that is both under an allowed directory and in the approved scope", () => {
  write("artifacts/playwright/repair-scope.json", JSON.stringify({ approvedPaths: ["e2e/tests/existing.spec.ts"] }));
  const result = runHook("repair-write-guard.mjs", stdin("Edit", "e2e/tests/existing.spec.ts", { old_string: "a", new_string: "b" }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
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

test("ignores tool calls that aren't Edit or Write (defensive fallback)", () => {
  const result = runHook("repair-write-guard.mjs", JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } }), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(0);
});
