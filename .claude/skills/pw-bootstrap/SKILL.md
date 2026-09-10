---
name: pw-bootstrap
description: Resume and safely continue the Playwright Quality Engineering Framework's staged build (PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md). Use when asked to "continue the framework build", "start the next stage", or "resume the Playwright staging plan" -- never to skip ahead past an unaudited stage.
argument-hint: "[stage NN | \"status\" | \"next\"]"
---

## When to use

Use `/pw-bootstrap` to find out where the staged build actually stands, or to move it forward one
stage at a time. Use `/pw-bootstrap status` (or no argument) just to report state without changing
anything. Do not use this to jump directly into writing framework code without going through it --
the whole point is that every stage transition is gated on the previous stage's passing audit.

## Do not use when

- You already know exactly which single file needs a small, unrelated fix (just make the edit).
- A stage's implementation is done but its audit hasn't run yet -- that's `playwright-reviewer`'s
  job (dispatch it directly, or ask this skill to do so as part of closing out the current stage).
- You want to repair one specific failing test -- use `/pw-repair-test` instead.

## Preflight (always, before touching anything)

1. Read `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` Section 4 ("Persistent Implementation State") for
   the current stage, current task, last passing audit, and active blockers.
2. Cross-check that against the Progress Dashboard and the most recent Implementation Log rows --
   if they disagree, the ledger itself is inconsistent; stop and report the discrepancy rather than
   guessing which one is right.
3. Confirm the live app is actually reachable before any stage that needs it: `pg_lsclusters` (start
   the cluster if it's down), `curl http://localhost:3000` (start `pnpm dev` in the background if
   it isn't running yet, e.g. `nohup pnpm dev > /tmp/seatwise-dev.log 2>&1 & disown`).

## What this skill does

**To report status:** summarize the Persistent Implementation State section verbatim, plus which
stage's audit gate checkboxes are still unchecked.

**To advance one stage:**

1. Implement the stage's task list in `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` exactly as scoped --
   never more (don't start Stage N+1 work while finishing Stage N) and never less (every task
   checkbox needs real, verified work behind it, not just a checked box).
2. Verify with real commands, never only unit assertions in isolation: `pnpm exec tsc --noEmit`,
   `pnpm pw:validate`, `pnpm pw:test`, and whatever stage-specific live check applies (a real
   `pnpm pw:run`, a real generated report opened and inspected, a real hook invocation).
3. Update documentation (`PLAYWRIGHT_TESTING.md`, `README.md`) for what the stage added.
4. Update the ledger: new Decision Log rows for any real design decision made, task/acceptance
   checkboxes, the Progress Dashboard, Section 4's Persistent Implementation State, and a new
   Implementation Log row -- in the same tone, format, and rigor as the existing rows. **A
   `PreToolUse` hook (`.claude/hooks/stage-gate-check.mjs`) will refuse any edit to this file that
   would leave a stage's Progress Dashboard box checked without a `quality/audits/stage-NN-audit.md`
   that says `Result: PASS` -- so the audit (next step) must exist and pass before that box can be
   checked.**
5. Dispatch `playwright-reviewer` (a fresh-context, read-only subagent) to independently audit the
   stage against its task list, acceptance criteria, and audit gate. It must run real commands, be
   adversarial, and may fix High-or-above findings itself only by handing you the fix to apply (it
   cannot write files) -- or, more simply for a Claude Code session that can dispatch subagents with
   write access for this purpose, a temporary elevated audit context that fixes findings live with
   locking regression tests and writes `quality/audits/stage-NN-audit.md` itself, exactly as this
   framework's own Stage 00-07 audits have done.
6. **Independently re-verify the audit's own claims yourself** before trusting them: re-read the
   changed files, re-run the commands it claims passed, and spot-check at least one live
   reproduction of anything it says it fixed. Do not skip this step because the audit report reads
   convincingly -- that is precisely the failure mode stage-gating exists to catch.
7. Commit the stage.

## Stop conditions (require a human)

- The current stage's audit comes back with a finding that isn't safely fixable without a
  human decision (an ambiguous requirement, a production-safety question, a real design tradeoff).
- BLK-001 (no GitHub authorization) blocks a push/PR -- note it and continue with the next stage's
  implementation/audit work rather than blocking on it, per this project's own standing policy, but
  never silently drop the fact that it's still blocked from the ledger.
- The ledger's own recorded state (Section 4 vs. Progress Dashboard vs. Implementation Log) is
  self-contradictory in a way this skill cannot safely resolve on its own.

## Never

Never check a Progress Dashboard box, and never claim a stage's acceptance criteria are met, without
a real, independently-audited pass behind it. Never silently change what an earlier stage decided
(a Decision Log entry) without a new, dated Decision Log row explaining why and what changed.
