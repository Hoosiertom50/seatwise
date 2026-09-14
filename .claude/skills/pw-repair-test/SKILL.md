---
name: pw-repair-test
description: Repair exactly one explicitly identified, already-triaged failing test, within a narrow, hook-enforced set of test-framework paths, after explicit human confirmation of the target. Only invoke when a human has asked for a specific test to be fixed and a triage report (or clear manual diagnosis) already exists.
argument-hint: "<test-id-or-file-path> [--reason \"...\"]"
disable-model-invocation: true
context: fork
agent: playwright-repair
background: false
---

## When to use

Use only after `/pw-triage-failures` (or an equally clear manual diagnosis) has identified one
specific test as safe and appropriate to repair, and a human has asked for that specific test to be
fixed. This skill never decides on its own that a test needs repairing.

## Do not use when

- No triage/diagnosis exists yet -- run `/pw-triage-failures` first.
- The failure is a real product regression, not a problem with the test itself -- fixing the
  application is a different task entirely, and "repairing" the test in that case would hide a real
  bug.
- More than one or two closely related files need touching -- that's larger than a "repair" and
  should be a normal, fully-reviewed change instead.

## Required arguments

The exact test ID or file path to repair, and (recommended) the diagnosed reason from triage.

## Allowed scope of file changes -- mechanically enforced, not just documented

Only files under `e2e/tests/`, `e2e/pages/`, or `e2e/components/` (the directories committed in
`quality/repair-allowed-dirs.yaml`), and only files this session has explicitly approved (see
preflight below). This is not a convention the assistant is trusted to remember -- a `PreToolUse`
hook on the `playwright-repair` subagent (`.claude/hooks/repair-write-guard.mjs`) refuses any
`Edit`/`Write` outside both of those bounds, and refuses to ever create a new file. Widening the
outer directory allowlist requires a human directly editing
`quality/repair-allowed-dirs.yaml` themselves, outside this workflow -- this skill never does that.

## Preflight (hard requirement, not optional)

1. **Run (or locate) a `/pw-triage-failures` maintenance report that actually covers this test**,
   and confirm its finding's `repairAllowed` is `true`. If it's `false` (always the case for
   "Probable application defect" and "Insufficient evidence" -- Stage 09 acceptance criteria) or no
   finding covers this test at all, **stop here** -- this is not a "confirm harder" situation.
   `repair-write-guard.mjs` independently re-derives this from the most recent maintenance report
   itself and will refuse the write regardless of what this skill decides, so there is no path
   around it; the human confirmation in step 2 below can only ever narrow what a `repairAllowed:
   true` finding already permits, never override a `false` one.
2. Identify the exact target file(s) from that triage report.
3. **Confirm the exact target with the human before writing anything** (via `AskUserQuestion` if
   available, or by stating the exact file(s) and diagnosed root cause and requiring an explicit
   go-ahead otherwise). This is the "unless the human explicitly expands scope" half of the
   requirement -- do not skip it because the target seems obvious.
4. Only after that confirmation, write `artifacts/playwright/repair-scope.json`:
   `{"approvedPaths": ["<relative path(s)>"], "reason": "...", "confirmedAt": "<ISO timestamp>"}`.
   This file is what the `playwright-repair` subagent's write guard checks against; nothing is
   writable by that subagent until this file names it.
5. **If the diagnosed fix would broaden a selector, remove/weaken an assertion, add a fixed sleep,
   or add `.only`/`.skip`/`.fixme`, or touches a page/component object file at all** (Stage 09's own
   coarse diff-safety proxy in `repair-write-guard.mjs` flags every one of these), ask the human
   specifically about that additional risk before proceeding, then add it to
   `repair-scope.json`'s `justifiedExceptions` array as `{"category": "<the flagged category>",
   "reason": "<what the human said>"}`. An empty or missing reason does not count -- the hook fails
   safe and denies. Never add a justified exception the human wasn't actually asked about.
6. Reproduce the failure for real (`pnpm pw:run` against the specific test) before forking into
   repair, so the before-state is concretely established, not assumed from the triage report alone.

## What this skill does

Forks into the `playwright-repair` subagent (via `context: fork`), passing the confirmed target and
diagnosed cause. That subagent makes the smallest edit that addresses the root cause, re-runs the
test for real, and runs `pnpm exec tsc --noEmit` / `pnpm pw:lint-tests` to confirm nothing else
broke -- all within the bounds the hooks enforce (see `.claude/agents/playwright-repair.md`).

## Expected output

A diff limited to the approved file(s), a real before/after test run showing the failure is
resolved, and a plain report of exactly what changed and why -- never a claim of success without a
real re-run backing it.

## Stop conditions

- No maintenance report finding covers this test, or its `repairAllowed` is `false` -- run/re-run
  `/pw-triage-failures` and follow ITS recommendation instead; do not attempt this workflow anyway.
- The human declines to confirm the target, or the target is ambiguous.
- `repair-write-guard.mjs` denies a write the subagent attempts -- that means either the scope given
  was too narrow for what's actually needed, a diff-safety category needs a `justifiedException` you
  haven't asked the human about yet, or the maintenance report itself doesn't permit this repair;
  stop and address whichever the denial reason names rather than trying to route around it.
- The fix would need to touch application source, a shared fixture, or a governance file -- that is
  out of scope for this workflow entirely.

## Never

Never let the repair change what the test asserts in order to make it pass -- a fix addresses a
stale locator, timing, or test data, never the test's own definition of success. Never widen scope
beyond what was explicitly confirmed. Never skip the real before/after run.
