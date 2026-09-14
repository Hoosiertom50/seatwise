---
name: pw-validate-framework
description: Run every offline, deterministic framework check -- schemas, structural lint, types, unit tests, discovery -- plus a framework smoke test. Use before committing any change to the Playwright Quality Engineering Framework itself, or when asked to "make sure the framework is healthy".
---

## When to use

Use this before committing any change under `playwright-framework/`, `e2e/`, `quality/*.yaml`,
`.claude/`, or the spec/docs, and any time asked whether the framework is in a good state. This is
the fast, offline gate every stage of this build has run before trusting its own work.

## Allowed scope of file changes

None. Purely a verification workflow.

## Deterministic commands this skill invokes, in order

1. `pnpm exec tsc --noEmit` -- typecheck everything.
2. `pnpm pw:validate-metadata` -- zod-validates every `quality/*.yaml` governance file plus
   cross-file consistency rules (unique requirement IDs, unique tag names, valid override
   references).
3. `pnpm pw:lint-tests` -- structural authoring-standards lint (raw selectors, fixed waits, missing
   steps) over every discovered test.
4. `playwright test --project=chromium --project=framework-unit --list` -- confirms every test is
   still discoverable and nothing fails to even collect.
5. `pnpm pw:test` -- the full `framework-unit` + `chromium` suite (unit tests plus this repo's own
   two lightweight application reference tests -- not a full browser regression run of a real
   product suite, which this framework doesn't have the scale to need yet).

(`pnpm pw:validate` already composes steps 1-4; this skill runs it plus step 5 and reports each
step's real pass/fail individually, since the audit gate and stage-gate hook both want to know which
specific check failed, not just an aggregate result.)

## "Framework smoke test"

After the above, confirm the framework's own generation commands run end-to-end without error
against whatever real data currently exists: `pnpm pw:review` (suite review generates without
throwing) and, if a recent run report exists, `pnpm pw:report:run <runId>` starts and serves without
error (then is stopped again -- never left running).

## Expected output

A plain pass/fail report per step, with the real command output for any step that failed --
never a single aggregate "looks fine."

## Stop conditions

- Any step fails -- report it precisely (which command, what it printed) rather than attempting an
  automatic fix as part of "just validating."

## Never

Never skip a step because an earlier one already failed -- report all of them, since later steps'
results are still useful context for diagnosing the first failure.
