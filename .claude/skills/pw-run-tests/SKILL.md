---
name: pw-run-tests
description: Preview a tag-expression test selection, run this framework's safety checks, execute it, and produce the Stage 06 run report. Use when asked to "run the tests", "run the regression suite", or "run just the mutating tests" -- never runs anything against a production hostname.
argument-hint: "<tag-expression | --selection readonly|smoke|regression|critical>"
---

## When to use

Use this any time tests actually need to execute against the live application -- verifying a fix,
confirming a new test passes, or a routine run. Do not use this to just discover which tests would
match a selection without running them (`pnpm pw:run --list` / `pnpm pw:list` does that without
executing anything, and this skill should preview the match before running for exactly this reason).

## Required arguments

A tag expression (e.g. `@suite:regression`, `@feature:guests and @readonly`) or one of the named
`--selection` shortcuts this repo already defines (`readonly`, `smoke`, `regression`, `critical`).

## Preflight (always)

1. Confirm the target is not a production hostname (Section 6's production guard;
   `e2e/support/productionGuard.ts` already enforces this at runtime, but preview it here too).
2. Confirm the app and its Postgres cluster are reachable (`curl http://localhost:3000`,
   `pg_lsclusters`) -- start them if not, exactly as `/pw-bootstrap`'s preflight does.
3. Preview the selection first (`pnpm pw:run <expression> --list` if supported, or read the tag
   expression against `pnpm pw:list`'s output) so the human/agent running this can see what will
   execute before anything mutates state.

## Deterministic commands this skill invokes

`pnpm pw:run "<expression>"` (or the `pw:run:<selection>` shortcut script), which itself generates a
Stage 05 run manifest and a Stage 06 run report (`artifacts/playwright/runs/run-reports/<runId>`).
Never hand-constructs a Playwright CLI invocation directly -- always goes through this repo's own
`run-tests.ts` so the safety checks, manifest, and report all stay wired together.

## Expected output

A real pass/fail result printed to the terminal, plus the generated run report
(`pnpm pw:report:run <runId>` to view it, or `pnpm pw:report:run` for the most recent one).

## Stop conditions

- The resolved target host is a production hostname -- refuse and say so; do not attempt to bypass
  the production guard.
- The tag expression matches zero tests -- report that plainly rather than silently "succeeding."
- The app or database isn't reachable and can't be started safely.

## Never

Never mark a `@mutating` test's data as cleaned up without the shared fixture's own teardown having
actually run. Never suppress or hide a failing test's output to make a run look cleaner than it was.
