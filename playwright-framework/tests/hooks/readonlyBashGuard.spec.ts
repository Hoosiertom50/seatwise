// Stage 08 -- readonly-bash-guard.mjs. This script has no filesystem dependencies of its own (it
// only inspects the hook input JSON), so unlike the other two PreToolUse guards these tests run
// directly against the real repo checkout with no fake root needed.
import { test, expect } from "@playwright/test";
import { runHook, permissionDecision } from "./runHook.js";

function bashStdin(command: string) {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command } });
}

test("allowed: a real, representative read-only framework command", () => {
  const result = runHook("readonly-bash-guard.mjs", bashStdin("pnpm exec tsc --noEmit"));
  expect(result.status).toBe(0);
  expect(permissionDecision(result)).toBe("allow");
});

test("allowed: git status/diff/log (read-only git subcommands are never blocked)", () => {
  for (const cmd of ["git status --short", "git diff HEAD", "git log --oneline -5"]) {
    const result = runHook("readonly-bash-guard.mjs", bashStdin(cmd));
    expect(result.status, `expected "${cmd}" to be allowed`).toBe(0);
  }
});

test("denied: every representative mutation pattern", () => {
  const mutatingCommands = [
    "rm -rf artifacts/",
    "mv a.ts b.ts",
    "cp a.ts b.ts",
    "sed -i 's/x/y/' file.ts",
    "echo secret | tee out.txt",
    "touch newfile.ts",
    "mkdir -p new/dir",
    "chmod +x script.sh",
    "chown user file.ts",
    "dd if=/dev/zero of=file",
    "truncate -s 0 file.ts",
    "unlink file.ts",
    "git add -A",
    "git commit -m 'x'",
    "git push origin main",
    "git checkout -- file.ts",
    "git reset --hard",
    "git clean -fd",
    "npm publish",
    "echo hi > file.txt",
    "echo hi >> file.txt",
    ":> file.txt",
  ];
  for (const cmd of mutatingCommands) {
    const result = runHook("readonly-bash-guard.mjs", bashStdin(cmd));
    expect(result.status, `expected "${cmd}" to be denied`).toBe(2);
    expect(permissionDecision(result)).toBe("deny");
  }
});

test("denied: interpreter inline-eval and symlink-creation commands that bypass every shell-syntax pattern above (Stage 08 audit finding, fixed)", () => {
  // Every one of these mutates a file's content or the filesystem's link structure without using
  // any of the shell-level primitives (`>`, `rm`, `sed -i`, etc.) the pre-fix blocklist relied on
  // exclusively -- confirmed live to be `allow`ed by the pre-fix script before this fix landed.
  const bypassCommands = [
    "node -e \"require('fs').writeFileSync('apps/web/src/foo.ts','HACKED')\"",
    "node --eval \"require('fs').writeFileSync('apps/web/src/foo.ts','HACKED')\"",
    "python3 -c \"open('apps/web/src/foo.ts','w').write('HACKED')\"",
    "python -c \"open('apps/web/src/foo.ts','w').write('HACKED')\"",
    "perl -i -e 's/x/y/' apps/web/src/foo.ts",
    "ruby -e \"File.write('apps/web/src/foo.ts','HACKED')\"",
    "php -r \"file_put_contents('apps/web/src/foo.ts','HACKED');\"",
    "ln -sf /etc/passwd e2e/tests/pwn.spec.ts",
    "git restore e2e/tests/foo.spec.ts",
  ];
  for (const cmd of bypassCommands) {
    const result = runHook("readonly-bash-guard.mjs", bashStdin(cmd));
    expect(result.status, `expected "${cmd}" to be denied`).toBe(2);
    expect(permissionDecision(result)).toBe("deny");
  }
});

test("denied: Write, Edit, and NotebookEdit are refused outright regardless of tool_input", () => {
  for (const toolName of ["Write", "Edit", "NotebookEdit"]) {
    const result = runHook("readonly-bash-guard.mjs", JSON.stringify({ tool_name: toolName, tool_input: { file_path: "x" } }));
    expect(result.status, `expected ${toolName} to be denied`).toBe(2);
    expect(result.stderr).toContain("read-only");
  }
});

test("ignores an unrelated tool (defensive fallback for a matcher misconfiguration)", () => {
  const result = runHook("readonly-bash-guard.mjs", JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } }));
  expect(result.status).toBe(0);
});

test("malformed: stdin is not valid JSON", () => {
  const result = runHook("readonly-bash-guard.mjs", "not json");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("malformed hook input");
});

test("missing: tool_input.command absent from a Bash call", () => {
  const result = runHook("readonly-bash-guard.mjs", JSON.stringify({ tool_name: "Bash", tool_input: {} }));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("command is missing");
});
