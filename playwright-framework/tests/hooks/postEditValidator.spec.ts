// Stage 08 -- post-edit-validator.mjs. The success-path tests run against this real repository's
// own already-valid files (cheap and safe: tsc/pw:validate-metadata/pw:lint-tests all already pass
// here, confirmed independently elsewhere in this stage). The one failure-path test uses a
// throwaway, deliberately-broken scratch .ts file created under e2e/tests/ for the duration of a
// single test and deleted immediately after (try/finally) -- never a real committed file.
import { test, expect } from "@playwright/test";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runHook } from "./runHook.js";

const REPO_ROOT = resolve(process.cwd());

function editStdin(filePath: string) {
  return JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath, old_string: "a", new_string: "a" }, cwd: REPO_ROOT });
}

test("no-op: a file outside the test/page-object/metadata/reporter/framework set is never checked", () => {
  const result = runHook("post-edit-validator.mjs", editStdin("README.md"));
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("nothing to check");
});

test("passes: a real, already-valid framework .ts file (tsc --noEmit)", () => {
  const result = runHook("post-edit-validator.mjs", editStdin("playwright-framework/version.ts"));
  expect(result.status).toBe(0);
  expect((result.json as any)?.systemMessage).toContain("tsc --noEmit passed");
});

test("passes: a real, already-valid governance yaml file (pw:validate-metadata)", () => {
  const result = runHook("post-edit-validator.mjs", editStdin("quality/tag-taxonomy.yaml"));
  expect(result.status).toBe(0);
  const message = (result.json as any)?.systemMessage as string;
  expect(message).toContain("pnpm pw:validate-metadata");
  expect(message).toContain("passed for quality/tag-taxonomy.yaml");
});

test("passes: a real, already-valid test spec file (both tsc --noEmit and pw:lint-tests run)", () => {
  const result = runHook("post-edit-validator.mjs", editStdin("e2e/tests/guest-viewing.spec.ts"));
  expect(result.status).toBe(0);
  const message = (result.json as any)?.systemMessage as string;
  expect(message).toContain("pnpm exec tsc --noEmit");
  expect(message).toContain("pnpm pw:lint-tests");
  expect(message).toContain("passed for e2e/tests/guest-viewing.spec.ts");
});

test("Stage 09: editing a real test spec also regenerates the suite review (pnpm pw:review runs)", () => {
  const result = runHook("post-edit-validator.mjs", editStdin("e2e/tests/guest-viewing.spec.ts"));
  expect(result.status).toBe(0);
  const message = (result.json as any)?.systemMessage as string;
  expect(message).toContain("pnpm pw:review");
});

test("Stage 09: editing a governance quality/*.yaml file also regenerates the suite review", () => {
  const result = runHook("post-edit-validator.mjs", editStdin("quality/tag-taxonomy.yaml"));
  expect(result.status).toBe(0);
  const message = (result.json as any)?.systemMessage as string;
  expect(message).toContain("pnpm pw:review");
});

test("surfaces a real failure: a deliberately broken scratch .ts file makes the project-wide typecheck fail", () => {
  const scratchPath = resolve(REPO_ROOT, "e2e/tests/_scratch-post-edit-validator-broken.spec.ts");
  writeFileSync(scratchPath, "this is not valid TypeScript at all { [[[ ;;;\n");
  try {
    const result = runHook("post-edit-validator.mjs", editStdin("e2e/tests/_scratch-post-edit-validator-broken.spec.ts"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tsc --noEmit failed");
  } finally {
    if (existsSync(scratchPath)) rmSync(scratchPath);
  }
});

test("no-op (fails open): malformed stdin never reports a false failure", () => {
  const result = runHook("post-edit-validator.mjs", "not json");
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("malformed hook input");
});

test("no-op (fails open): tool_input.file_path missing entirely", () => {
  const result = runHook("post-edit-validator.mjs", JSON.stringify({ tool_name: "Edit", tool_input: {} }));
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("file_path is missing");
});

test("no-op: a file_path that doesn't exist on disk (e.g. deleted right after the edit)", () => {
  const result = runHook("post-edit-validator.mjs", editStdin("playwright-framework/does-not-exist-at-all.ts"));
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("no longer exists on disk");
});

test("ignores an unrelated tool (defensive fallback)", () => {
  const result = runHook("post-edit-validator.mjs", JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } }));
  expect(result.status).toBe(0);
});
