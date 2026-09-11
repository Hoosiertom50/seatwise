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

None directly by the assistant. `pnpm pw:triage` (below) is the one thing that writes anything --
a new `artifacts/playwright/maintenance/<reportId>.{json,html}` file, gitignored/ephemeral like every
other generated report -- and it is a deterministic CLI, not a free-form edit. Delegates evidence
reading beyond that to the read-only `playwright-triage` subagent, which cannot write files even if
asked.

## Preflight

1. Identify the run to analyze: the `runId` argument if given, otherwise the most recent entry
   under `artifacts/playwright/runs/run-reports/` (which `pnpm pw:triage` also defaults to with no
   `--run-id` flag).
2. Confirm the run report and its referenced evidence (screenshots, traces, console/network logs)
   actually exist on disk before delegating -- a triage that can't find its own evidence should say
   so, not analyze from the summary text alone.

## Deterministic commands this skill invokes

`pnpm pw:triage [--run-id <id>]` (Stage 09) -- reads the target Stage 06 run report by run ID
(never rerunning anything -- pure artifact collection, per Section 09's own task) and Stage 07's
most recent suite review for sibling-test cross-reference, classifies every real failure against
Section 10.4's 7 categories via `playwright-framework/triage/classifyFailure.ts` (mechanical signals
first, then `quality/failure-classifications.yaml`'s hand-authored entries, then a fail-closed
"insufficient-evidence" default -- see that module's own doc comment, DEC-028), and writes the
schema-validated maintenance report. `pnpm pw:triage:serve [reportId]` serves it with working
links. `pnpm pw:run "<same expression>"` only if a fresh reproduction is genuinely needed to
confirm a failure is still current before triaging it.

## Expected output

A maintenance report (JSON + HTML) written by `pnpm pw:triage`: for each real failure, a
classification, confidence, expected-vs-observed behavior, evidence for/against an application
defect and a test defect, a recommended next action, and -- critically -- whether `/pw-repair-test`
is even allowed to touch it (`repairAllowed`, mechanically `false` for "Probable application
defect" and "Insufficient evidence"). `/pw-repair-test`'s own preflight, and separately
`repair-write-guard.mjs` itself, both require a matching finding with `repairAllowed: true` before
any repair write is permitted -- this skill's report IS that maintenance recommendation, not just
advisory prose.

## Stop conditions

- The run report or its evidence attachments are missing or don't resolve the cause -- `pw:triage`
  itself defaults to "Insufficient evidence" + `needsHumanReview: true` rather than guessing; report
  that plainly rather than trying to argue your way to a more confident-sounding category.
- The failure looks like a genuine application regression, not a test problem -- say so explicitly
  and do not route it toward `/pw-repair-test` (the report's own `repairAllowed: false` already
  reflects this for "Probable application defect").

## Never

Never recommend weakening an assertion as the fix. Never classify a failure with more confidence
than the actual evidence supports, and never hand-author a `quality/failure-classifications.yaml`
entry that claims more certainty than a human actually established.
