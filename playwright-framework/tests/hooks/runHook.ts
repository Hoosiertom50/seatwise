// Stage 08 -- shared test helper for the four .claude/hooks/*.mjs scripts. Every hook is a
// standalone Node process Claude Code itself spawns and feeds JSON on stdin, so these tests
// exercise the real, on-disk script exactly the same way: a real `node` child process, real stdin,
// real exit code -- never importing the script's internals directly (there are none to import;
// each script runs top-to-bottom and calls process.exit()).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd());
const HOOKS_DIR = resolve(REPO_ROOT, ".claude/hooks");

export interface HookRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Parsed stdout JSON, or undefined if stdout wasn't valid JSON (e.g. a no-op's stderr note). */
  json: unknown;
}

export function runHook(scriptName: string, stdin: string, envOverrides: Record<string, string> = {}): HookRunResult {
  const result = spawnSync("node", [resolve(HOOKS_DIR, scriptName)], {
    input: stdin,
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, ...envOverrides },
    encoding: "utf-8",
    timeout: 30_000,
  });
  let json: unknown;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : undefined;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

export function permissionDecision(result: HookRunResult): string | undefined {
  const output = result.json as { hookSpecificOutput?: { permissionDecision?: string } } | undefined;
  return output?.hookSpecificOutput?.permissionDecision;
}
