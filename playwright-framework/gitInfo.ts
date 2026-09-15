/**
 * Stage 07 — a single source of truth for the repository Git commit and working-tree state Section
 * 10.1 (run reports) and Section 10.3 (suite reviews) both require every generated report to
 * include. Originally a private helper inside cli/suite-review.ts; extracted here under TS-57 so
 * cli/triage.ts (Stage 09's maintenance reports) can reuse the exact same logic rather than a second,
 * possibly-drifting copy -- the same "computed once, single source of truth" discipline this
 * framework already applies to FRAMEWORK_VERSION (version.ts) and to `repairAllowed`
 * (triage/classifyFailure.ts's own doc comment).
 *
 * `reporting/normalizedReporter.ts` (Stage 06, a Playwright reporter rather than a CLI, and run
 * inside Playwright's own worker process rather than this repo's plain Node CLIs) keeps its own
 * inline copy of this same logic rather than importing this module -- reporters resolve `rootDir`
 * from Playwright's own `FullConfig`, not `process.cwd()`, so the two call sites were never proper
 * duplicates of each other to begin with. This module is for the CLI call sites only.
 */
import { execFileSync } from "node:child_process";

export interface GitInfo {
  gitCommit: string;
  workingTreeClean: boolean;
}

/** @param rootDir Directory to run `git` in. Defaults to `process.cwd()`, matching every existing
 * CLI call site (each already runs with the repo root as its own working directory). */
export function gitInfo(rootDir: string = process.cwd()): GitInfo {
  let gitCommit = "unknown";
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir }).toString().trim();
  } catch {
    // no git available -- recorded as "unknown", never fabricated (mirrors normalizedReporter.ts)
  }
  let workingTreeClean = true;
  try {
    workingTreeClean =
      execFileSync("git", ["status", "--porcelain"], { cwd: rootDir }).toString().trim().length === 0;
  } catch {
    workingTreeClean = true; // unknown treated as clean rather than falsely flagging dirty
  }
  return { gitCommit, workingTreeClean };
}
