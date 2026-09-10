---
name: pw-triage-failures
description: Analyze a selected failed Playwright run and produce a maintenance/root-cause triage report, using the real run report and its evidence attachments. Use after `pnpm pw:run`/`pnpm pw:test` produces failures and before deciding whether/how to repair anything.
argument-hint: "[runId]"
---

## When to use

Use this once a real run has actually failed (via `/pw-run-tests` or otherwise) and you need an
honest classification before touching anything: is this a real product regression, test flakiness,
an environment problem, or a test that's simply wrong. Never skip straight to `/pw-repair-test`
without this step -- repair should never guess at a root cause on its own.

## Allowed scope of file changes

None. This is a pure analysis workflow; it produces a report, not an edit. Delegates the actual
evidence-reading to the read-only `playwright-triage` subagent, which cannot write files even if
asked.

## Preflight

1. Identify the run to analyze: the `runId` argument if given, otherwise the most recent entry
   under `artifacts/playwright/runs/run-reports/`.
2. Confirm the run report and its referenced evidence (screenshots, traces, console/network logs)
   actually exist on disk before delegating -- a triage that can't find its own evidence should say
   so, not analyze from the summary text alone.

## Deterministic commands this skill invokes

None directly for analysis (reading is enough); `pnpm pw:run "<same expression>"` only if a fresh
reproduction is genuinely needed to confirm a failure is still current before triaging it.

## Expected output

A maintenance report: for each failing test, a root-cause classification with the specific evidence
that supports it, and whether it's a safe candidate for `/pw-repair-test` at all (a real product
regression should never be "fixed" by editing the test that caught it).

## Stop conditions

- The run report or its evidence attachments are missing or don't resolve the cause -- report
  "insufficient evidence, needs human review" rather than guessing.
- The failure looks like a genuine application regression, not a test problem -- say so explicitly
  and do not route it toward `/pw-repair-test`.

## Never

Never recommend weakening an assertion as the fix. Never classify a failure with more confidence
than the actual evidence supports.
