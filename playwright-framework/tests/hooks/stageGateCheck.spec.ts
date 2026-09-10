// Stage 08 -- stage-gate-check.mjs, fully isolated against a throwaway fake repository root with
// its own tiny spec file and quality/audits/ directory (never the real
// PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md, so these tests can never accidentally corrupt this
// project's own ledger).
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./runHook.js";

const SPEC_RELATIVE = "PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md";

let fakeRoot: string;

function write(relPath: string, content: string): void {
  const abs = join(fakeRoot, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, content);
}

const BASE_SPEC = [
  "### Progress dashboard",
  "",
  "- [x] Stage 00 — Repository discovery and implementation plan",
  "- [ ] Stage 01 — Playwright foundation and environment safety",
  "- [ ] Stage 09 — Failure triage and controlled test repair",
  "",
].join("\n");

test.beforeEach(() => {
  fakeRoot = mkdtempSync(join(tmpdir(), "stage-gate-check-"));
  write(SPEC_RELATIVE, BASE_SPEC);
  write("quality/audits/stage-00-audit.md", "# Stage 00 Audit\n\nResult: PASS\n");
});

test.afterEach(() => {
  rmSync(fakeRoot, { recursive: true, force: true });
});

function editStdin(oldString: string, newString: string, replaceAll = false) {
  return JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: SPEC_RELATIVE, old_string: oldString, new_string: newString, replace_all: replaceAll },
    cwd: fakeRoot,
  });
}

test("allowed: checking a stage box whose audit file already exists and says Result: PASS", () => {
  const result = runHook(
    "stage-gate-check.mjs",
    editStdin("- [ ] Stage 01 — Playwright foundation and environment safety", "- [x] Stage 01 — Playwright foundation and environment safety"),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  // Stage 01 isn't audited yet in this fixture -- add its audit first, matching the allowed case.
  write("quality/audits/stage-01-audit.md", "# Stage 01 Audit\n\nResult: PASS WITH FINDINGS (one closed)\n");
  const result2 = runHook(
    "stage-gate-check.mjs",
    editStdin("- [ ] Stage 01 — Playwright foundation and environment safety", "- [x] Stage 01 — Playwright foundation and environment safety"),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result2.status).toBe(0);
  expect((result2.json as any)?.hookSpecificOutput?.permissionDecision).toBe("allow");
  void result; // the first, pre-audit attempt is exercised by the "denied" test below instead
});

test("denied: checking a stage box that has no quality/audits/stage-NN-audit.md at all", () => {
  const result = runHook(
    "stage-gate-check.mjs",
    editStdin("- [ ] Stage 09 — Failure triage and controlled test repair", "- [x] Stage 09 — Failure triage and controlled test repair"),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("stage-09-audit.md does not exist yet");
});

test("denied: the audit file exists but its Result line is not a PASS", () => {
  write("quality/audits/stage-09-audit.md", "# Stage 09 Audit\n\nResult: FAIL (blocking issue unresolved)\n");
  const result = runHook(
    "stage-gate-check.mjs",
    editStdin("- [ ] Stage 09 — Failure triage and controlled test repair", "- [x] Stage 09 — Failure triage and controlled test repair"),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('does not start with "PASS"');
});

test("denied: the audit file's own first Result: line is FAIL even though a later, unrelated line elsewhere in the file happens to say Result: PASS (Stage 08 audit finding, fixed)", () => {
  write(
    "quality/audits/stage-09-audit.md",
    [
      "# Stage 09 Audit",
      "",
      "Result: FAIL (three blocking findings unresolved)",
      "",
      "## Appendix: house style example quoted from another audit",
      "",
      "Result: PASS",
      "",
    ].join("\n"),
  );
  const result = runHook(
    "stage-gate-check.mjs",
    editStdin("- [ ] Stage 09 — Failure triage and controlled test repair", "- [x] Stage 09 — Failure triage and controlled test repair"),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('does not start with "PASS"');
});

test("allowed: an edit that doesn't touch any Progress Dashboard checkbox at all", () => {
  const result = runHook("stage-gate-check.mjs", editStdin("Progress dashboard", "Progress dashboard (updated)"), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(0);
});

test("allowed (fast no-op): edits to a file other than the spec ledger are never inspected", () => {
  write("README.md", "hello");
  const result = runHook(
    "stage-gate-check.mjs",
    JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "README.md", old_string: "hello", new_string: "hi" }, cwd: fakeRoot }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  expect(result.status).toBe(0);
});

test("malformed: stdin is not valid JSON", () => {
  const result = runHook("stage-gate-check.mjs", "{{not json", { CLAUDE_PROJECT_DIR: fakeRoot });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("malformed hook input");
});

test("malformed: Edit's old_string cannot be located in the file's real current content (fails safe)", () => {
  const result = runHook("stage-gate-check.mjs", editStdin("this text is nowhere in the fixture spec file", "x"), {
    CLAUDE_PROJECT_DIR: fakeRoot,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("could not locate old_string");
});

test("missing: tool_input.file_path absent entirely", () => {
  const result = runHook("stage-gate-check.mjs", JSON.stringify({ tool_name: "Edit", tool_input: {} }), { CLAUDE_PROJECT_DIR: fakeRoot });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("file_path is missing");
});

test("a real multi-stage Write (the whole file rewritten at once) is checked against every checked box, not just one", () => {
  write("quality/audits/stage-01-audit.md", "# Stage 01 Audit\n\nResult: PASS\n");
  const newContent = BASE_SPEC.replace("- [ ] Stage 01", "- [x] Stage 01").replace("- [ ] Stage 09", "- [x] Stage 09");
  const result = runHook(
    "stage-gate-check.mjs",
    JSON.stringify({ tool_name: "Write", tool_input: { file_path: SPEC_RELATIVE, content: newContent }, cwd: fakeRoot }),
    { CLAUDE_PROJECT_DIR: fakeRoot },
  );
  // Stage 01 has a passing audit but Stage 09 does not -- the whole write must still be denied.
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("stage-09-audit.md does not exist yet");
  // sanity: confirm the fixture file on disk was untouched by this hook (hooks never write files)
  expect(readFileSync(join(fakeRoot, SPEC_RELATIVE), "utf-8")).toBe(BASE_SPEC);
});
