/**
 * Stage 08 -- tiny shared helpers used by every hook script under .claude/hooks/. Kept dependency-
 * free (no zod, no yaml) and framework-agnostic on purpose: hooks are spawned as one-off Node
 * processes by Claude Code itself, outside this repo's own tsx/pnpm task graph, so they must work
 * with nothing more than a plain `node <script>.mjs` invocation and whatever is already in
 * node_modules. Every hook script imports only this file plus, where actually needed, the `yaml`
 * package already a devDependency of this workspace (never re-implemented here).
 *
 * All four hook scripts (repair-write-guard, stage-gate-check, post-edit-validator,
 * readonly-bash-guard) follow the same shape: read one JSON object from stdin, decide, write a
 * small JSON decision to stdout, and exit with a documented code. See
 * PLAYWRIGHT_TESTING.md's "Claude Code integration (Stage 08)" section for the exit-code contract
 * this relies on (current as of the Claude Code hooks documentation read for this stage).
 */
import { readFileSync } from "node:fs";

/**
 * Reads and parses the hook's JSON input from stdin (fd 0). Never throws -- returns a tagged
 * result so every caller can implement its own fail-safe direction for "stdin was unreadable" vs.
 * "stdin was not valid JSON", both of which the Stage 08 audit gate requires a covered test for
 * ("malformed ... hook inputs").
 */
export function readStdinJson() {
  let raw;
  try {
    raw = readFileSync(0, "utf-8");
  } catch (err) {
    return { ok: false, error: `could not read stdin: ${err.message}` };
  }
  if (!raw || !raw.trim()) {
    return { ok: false, error: "stdin was empty" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `stdin was not valid JSON: ${err.message}` };
  }
}

/**
 * The project root a hook script should resolve every repo-relative path against. Prefers
 * `CLAUDE_PROJECT_DIR` (documented as exported to every spawned hook process and stable across
 * worktrees) over the hook input's own `cwd` field, falling back to the script's own process cwd
 * only as a last resort for direct/manual invocations (e.g. this stage's own unit tests).
 */
export function projectRoot(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
}

/** Emits a PreToolUse "allow" decision and exits 0. */
export function allow(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/**
 * Emits a PreToolUse "deny" decision and exits 2. Exit 2 is what makes a PreToolUse hook's
 * decision authoritative and blocking per Claude Code's documented exit-code contract (stderr
 * becomes the block reason; the JSON `permissionDecisionReason` is the same text so both the
 * transcript and a direct script invocation show identical wording).
 */
export function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.stderr.write(reason + "\n");
  process.exit(2);
}

/** A quiet, non-blocking no-op (used for "this call isn't ours to police" fast paths). */
export function noop(message) {
  if (message) process.stderr.write(message + "\n");
  process.exit(0);
}
