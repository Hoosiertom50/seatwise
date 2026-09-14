---
name: pw-author-test
description: Author one or more new Playwright tests from an approved requirement in quality/requirements.yaml, or from a manually-described case, following this framework's defineQualityTest/fixture/tagging/evidence conventions. Use when asked to "write a test for X" or "add coverage for requirement REQ-...".
argument-hint: "<requirement-id-or-description> [--readonly|--mutating]"
---

## When to use

Use this to add a genuinely new test: a requirement in `quality/requirements.yaml` has no covering
test yet (check `pnpm pw:review`'s coverage numbers first), or a human describes a specific new case
by hand. Do not use this to fix an existing failing test -- that's `/pw-repair-test`.

## Required arguments

- The requirement ID (`REQ-...` from `quality/requirements.yaml`) the new test should cover, or a
  precise manual description if no requirement entry exists yet (in which case, add the requirement
  entry to `quality/requirements.yaml` first, as its own reviewable change).
- Whether the test is `@readonly` or `@mutating` (Section 5/6's data-impact tag), since that decides
  which fixture (`managedWedding` and friends in `e2e/fixtures/index.ts`) and which default
  `@suite:*` tags apply.

## Allowed scope of file changes

Only `e2e/tests/**/*.spec.ts` (the new test itself), and, only if the case genuinely needs one that
doesn't already exist, a new page-object method in `e2e/pages/**` or component in `e2e/components/**`
-- never a change to an existing page-object method's behavior beyond adding what the new test
needs, never `e2e/fixtures/**`, `e2e/support/**`, or anything under `playwright-framework/**`. If the
case seems to require changing shared fixture/support code, stop and say so rather than doing it
silently as part of "authoring a test."

## Extending an existing test vs. authoring a new one (Stage 09)

When the application gains new functionality closely related to an already-tested behavior, decide
deliberately rather than defaulting to either extreme:

- **Add a focused validation to the existing test** when the new behavior is a direct, small
  extension of what that test already Arranges/Acts on (e.g. the same guest-list view now also
  shows a new field) -- add a named `test.step` for it, and update `expectedOutcome` to say so.
- **Create a separate, independent test** when the new functionality is its own distinct behavior,
  user flow, or failure mode (a new mutating action, a different page, a different access-control
  boundary) even if it's topically related -- give it its own `requirementIds`/objective.

Never overload one test with unrelated outcomes just because they happen to touch the same page --
that produces a test whose failure doesn't say which of several unrelated things actually broke,
and inflates the "independence" and "objective-traceability" criteria's real meaning per test.

## Preflight

1. Confirm the app is reachable (`pnpm dev`, Postgres cluster) -- a new test must be verified
   against the real, running application, not written and trusted blind.
2. Read the target requirement in `quality/requirements.yaml` and the existing reference tests
   (`e2e/tests/guest-viewing.spec.ts`, `e2e/tests/guest-management.spec.ts`) for the house style:
   `defineQualityTest`, the shared fixture import, `test.step` Arrange/Act/Assert, tags, and
   `evidence.checkpoint(...)` calls.
3. Run `pnpm pw:lint-tests` and `pnpm pw:validate-metadata` before writing anything, so any existing
   failure isn't mistaken for something the new test introduced.

## Deterministic commands this skill invokes

`pnpm pw:lint-tests` (structural authoring-standards check), `pnpm exec tsc --noEmit`,
`pnpm pw:run "<tag or test file>"` (real execution against the live app), `pnpm pw:validate-metadata`
(confirms the requirement ID and tags used are real and consistently named).

## Expected output

A new `*.spec.ts` file under `e2e/tests/`, passing `pnpm pw:lint-tests` and a real `pnpm pw:run`
execution, plus (if the requirement was new) an added `quality/requirements.yaml` entry.

## Stop conditions

- The requirement doesn't exist and its priority/impact can't be determined without a human (per
  DEC-021, business-value judgments are never invented).
- The case requires a shared fixture, page-object, or support-code change beyond what's in scope.
- The real application doesn't behave the way the case assumes -- that's a product question, not a
  test-authoring one; report it rather than writing a test around unexpected behavior.

## Never

Never invent test data cleanup shortcuts that skip the shared fixtures. Never mark a test
`@suite:regression`/`@suite:critical` without it actually passing a real run first. Never silently
change what an existing test or fixture does while "just adding a new test."
