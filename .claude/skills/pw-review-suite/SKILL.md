---
name: pw-review-suite
description: Discover every application test, validate its metadata, score its value/quality, and generate the Stage 07 suite-review report (coverage, duplicates, review queue). Use when asked to "review the test suite", "how good is our test coverage", or "what should we look at first".
argument-hint: "[--freshness-window-days <n>]"
---

## When to use

Use this to get an up-to-date picture of the whole test suite: coverage against requirements,
duplicate candidates, per-test value/quality scores, and a prioritized review queue. This is purely
a reporting workflow -- it never changes a test's behavior. If you already know which specific test
is failing and why, `/pw-triage-failures` (for classification) or `/pw-repair-test` (for a fix) are
the right tools instead.

## Allowed scope of file changes

None to source. This skill only writes generated report artifacts under
`artifacts/playwright/runs/suite-reviews/` (gitignored, never committed) and reads
`quality/*.yaml`. It never edits a test, a page object, or a governance file.

## Preflight

1. Confirm `quality/test-evaluations.yaml`'s `modelVersion` matches the live
   `quality/test-value-model.yaml` -- `pnpm pw:review` itself warns on a mismatch; don't ignore that
   warning.
2. If a fresh run-report history matters for the numbers you're about to report (health
   classification depends on it), run `pnpm pw:run "@suite:regression"` first so the review reflects
   current pass/fail state rather than stale history.

## Deterministic commands this skill invokes

`pnpm pw:review` (generates the JSON + HTML suite review) and, to actually view the HTML report's
source-file links correctly, `pnpm pw:review:serve`.

## Expected output

The generated suite-review JSON/HTML, plus a plain-language summary: requirement coverage (plain and
risk-weighted), any duplicate candidates, the score distribution, and the top items in the
prioritized review queue with their reasons.

## Stop conditions

- `quality/*.yaml` fails to load (missing/invalid governance file) -- report the exact error rather
  than guessing at partial numbers.
- Zero tests are discovered -- report that plainly; it usually means `e2e/tests/` was moved or
  emptied, not that coverage is "0% and fine."

## Never

Never present a `needsHumanReview: true` criterion as a concrete score. Never round a provisional
value/quality total to look more resolved than DEC-021 says it honestly is.
