#!/usr/bin/env node
/**
 * Stage 08 -- Section 11.4 hook requirement #2: "A lightweight post-edit validator for changed
 * Playwright test, page-object, metadata, reporter, or framework files. It may run asynchronously
 * but must surface failures."
 *
 * Wired project-wide in `.claude/settings.json` as a PostToolUse hook matching Edit|Write. Unlike
 * the two PreToolUse guards in this directory, PostToolUse hooks cannot block anything -- the edit
 * has already happened by the time this runs -- so this script's only job is to run a fast,
 * deterministic check appropriate to what changed and surface a failure loudly if one exists.
 * "Lightweight" is a hard requirement (Section 11.4: "Never run the complete browser suite after
 * every file edit"), so this never launches Playwright's own browser-backed test projects; it only
 * ever runs typecheck, the structural test-authoring linter (`pw:lint-tests`, itself AST-only, no
 * browser), and metadata schema validation (`pw:validate-metadata`, zod-only) -- exactly the three
 * non-browser checks `pw:validate` already composes, scoped down to only the ones relevant to the
 * file that actually changed.
 *
 *   - A changed `quality/*.yaml` governance file           -> `pnpm pw:validate-metadata`
 *   - A changed `*.ts` file under e2e/ or playwright-framework/ -> `pnpm exec tsc --noEmit`
 *   - ...and if that `*.ts` file is itself a test spec (`*.spec.ts` under e2e/tests or
 *     playwright-framework/tests) -> also `pnpm pw:lint-tests`
 *   - Anything else (docs, config outside the above, etc.)  -> no-op
 *
 * Fails open throughout (an unparseable hook input or a file that no longer exists on disk is a
 * silent no-op, never a false failure report) since this hook cannot block and a noisy false
 * positive would only train whoever reads the transcript to ignore it.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readStdinJson, projectRoot, noop } from "./lib/hookIO.mjs";

const parsed = readStdinJson();
if (!parsed.ok) {
  noop(`post-edit-validator: skipping (malformed hook input) -- ${parsed.error}`);
}
const input = parsed.value;

const toolName = input.tool_name;
if (toolName !== "Edit" && toolName !== "Write") {
  noop(`post-edit-validator: ignoring unrelated tool "${toolName}"`);
}

const toolInput = input.tool_input;
const filePath = toolInput && toolInput.file_path;
if (!filePath || typeof filePath !== "string") {
  noop("post-edit-validator: skipping -- tool_input.file_path is missing from hook input");
}

const root = resolve(projectRoot(input));
const resolvedTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
if (!existsSync(resolvedTarget)) {
  noop(`post-edit-validator: skipping -- "${filePath}" no longer exists on disk`);
}
const relPath = relative(root, resolvedTarget).split(sep).join("/");

const isGovernanceYaml = /^quality\/.+\.ya?ml$/.test(relPath);
const isFrameworkTs = /\.ts$/.test(relPath) && (relPath.startsWith("e2e/") || relPath.startsWith("playwright-framework/"));
const isTestSpec = /\.spec\.ts$/.test(relPath) && (relPath.startsWith("e2e/tests/") || relPath.startsWith("playwright-framework/tests/"));

if (!isGovernanceYaml && !isFrameworkTs) {
  noop(`post-edit-validator: "${relPath}" is not a test, page-object, metadata, reporter, or framework file -- nothing to check`);
}

const checks = [];
if (isGovernanceYaml) checks.push({ label: "pnpm pw:validate-metadata", cmd: "pnpm", args: ["pw:validate-metadata"] });
if (isFrameworkTs) checks.push({ label: "pnpm exec tsc --noEmit", cmd: "pnpm", args: ["exec", "tsc", "--noEmit"] });
if (isTestSpec) checks.push({ label: "pnpm pw:lint-tests", cmd: "pnpm", args: ["pw:lint-tests"] });

const failures = [];
for (const check of checks) {
  try {
    execFileSync(check.cmd, check.args, { cwd: root, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).map((b) => b.toString()).join("\n").trim();
    failures.push(`${check.label} failed for ${relPath}:\n${output.slice(0, 2000)}`);
  }
}

if (failures.length > 0) {
  // Non-blocking (this event can't block), but a nonzero, non-2 exit surfaces stderr as a
  // transcript error notice per Claude Code's documented "other exit code" behavior.
  process.stderr.write(failures.join("\n\n") + "\n");
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({ systemMessage: `post-edit-validator: ${checks.map((c) => c.label).join(", ")} passed for ${relPath}` }),
);
process.exit(0);
