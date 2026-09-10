# Stage 07 Audit

Result: PASS WITH FINDINGS (two High-severity bugs found and fixed live during this audit, with locking regression tests; no Medium/Low findings disclosed this time — every candidate edge case investigated held up)
Auditor: Independent review subagent, fresh context with no memory of the implementation work, instructed to treat the code as unseen and to run real commands rather than trust the implementation log's prose.
Date/time: 2026-09-10
Repository is a git repo (working tree, no commits made by this audit).

## Scope

Verify Stage 07 (suite review, coverage analysis, and test catalog) against
`PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`'s Section 10.3, the Stage 07 task list, acceptance criteria,
and audit gate, DEC-021/022/023, `PLAYWRIGHT_TESTING.md`'s Stage 07 section, and the precedent set
by `quality/audits/stage-06-audit.md`. The live app (`pnpm dev`, already running on
`http://localhost:3000`, confirmed via `curl` returning 200) and the app's own Postgres 16 cluster
(already `online` per `pg_lsclusters`) were used for every live run — nothing here is mocked.
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` was exported for every browser-backed command. Every file
named in the audit brief was read in full before any command was run.

## Files reviewed

- `playwright-framework/coverage/{runReportHistory,computeCoverage,detectDuplicates,buildReviewQueue,diffSuiteReviews}.ts` (in full, including after this audit's own fix)
- `playwright-framework/evaluation/evaluateTest.ts` (in full, including after this audit's own fix)
- `playwright-framework/reporting/renderSuiteReviewHtml.ts` (in full)
- `playwright-framework/cli/suite-review.ts`, `playwright-framework/cli/serve-suite-review.ts` (in full, the latter including after this audit's own fix)
- `playwright-framework/reporting/servedPath.ts` (new, this audit)
- `playwright-framework/metadata/schemas.ts` (the full `SuiteReview`/`TestEvaluation*`/`ScoreResult`/`CriterionResult` schema family)
- `playwright-framework/scoring/computeScore.ts`, `playwright-framework/scoring/applyOverride.ts`
- `quality/test-value-model.yaml`, `quality/test-evaluations.yaml`, `quality/requirements.yaml`, `quality/value-overrides.yaml`, `quality/tag-taxonomy.yaml`
- `e2e/tests/guest-viewing.spec.ts`, `e2e/tests/guest-management.spec.ts` (both real reference tests, read in full and hand-verified against their hand-authored evaluations)
- `playwright-framework/tests/{evaluateTest,computeCoverage,detectDuplicates,buildReviewQueue,diffSuiteReviews,runReportHistory,suiteReviewHtml}.spec.ts` (existing, read first so this audit's own probing targeted gaps, not duplicate coverage) plus this audit's own new/edited test files
- `PLAYWRIGHT_TESTING.md`'s "Suite review, coverage analysis, and test catalog (Stage 07)" section

## Verification commands run (numbers I personally observed, not taken from the log)

- `pnpm exec tsc --noEmit` — clean before, during, and after every fix in this audit.
- `pnpm pw:test` — **291/291 passed** before any fix (matches the implementer's claimed 254
  framework-unit + 37 chromium-project); **298/298 passed** after this audit's fixes (7 new locking
  tests: 1 added to `evaluateTest.spec.ts`, 6 in a new `servedPath.spec.ts`).
- `pnpm pw:validate` — clean before and after (`Total: 291 tests in 29 files` before, `Total: 298
  tests in 30 files` after).
- `pnpm pw:run "@suite:regression"` — real 2/2 pass, generating real Stage 06 run-report history
  used by every live suite-review run below.
- `pnpm pw:review` (real `tsx playwright-framework/cli/suite-review.ts`) — run **many** times over
  the course of this audit (clean baseline, freshness-window probe, missing-file probe, zero-test
  probe, override probe, final clean regeneration) — every one a genuine CLI invocation, nothing
  mocked or hand-constructed as JSON.
- `git status --short` at the end — only legitimate source/test changes and this report; no
  scratch/probe files left (see "Cleanup" at the end for exactly what was created and removed).

## 1. Manual trace of value/quality scores back to source evidence

Generated a real suite review against the real 2-test suite. Independently hand-verified, criterion
by criterion, for both real tests:

- **guest-viewing.guest-list-shows-existing-guests**: quality 20+19+15+15+8+10+5+5 = **97**, value
  0+0+0+5+15+0 = **20**. **guest-management.add-guest-appears-in-list**: quality
  20+18+15+15+8+10+5+5 = **96**, value 0+0+0+7+15+0 = **22**. Both match the generated JSON exactly
  and match the implementer's claimed totals.
- **independence-and-parallel-safety (20/20 both)**: confirmed both spec files literally
  `import { defineQualityTest, expect, test } from "../fixtures/index.js"` — the regex the evaluator
  checks for is genuinely satisfied, not assumed.
- **deterministic-waiting/locator-design (15/15 both)**: ran `pnpm pw:lint-tests` for real — zero
  fixed-wait or raw-selector/raw-screenshot violations in either file (the tool's only non-passing
  finding in the whole repo is an explicitly-excepted `raw-selector-in-test` in
  `framework-health.spec.ts`, which is not either reference test).
- **readability (10/10 both)**: both files literally contain exactly 3 `test.step(...)` calls
  (Arrange/Act/Assert) — confirmed by reading the source directly, matching the `stepCount >= 3`
  branch.
- **evidence (5/5 both)**: both call `evidence.checkpoint(...)` and the fresh run report (from a
  real `pnpm pw:run "@suite:regression"` in this audit) recorded a checkpoint for both.
- **test-data-cleanup (8/10 both)**: matches the disclosed, permanent DEC-012 account-deletion gap
  exactly as documented — not silently rounded up to 10.
- **assertion-strength (18/20, 19/20) and security-compliance (7/15, 5/15)**: read
  `quality/test-evaluations.yaml`'s hand-authored rationale for both criteria on both tests, then
  independently re-read the actual test source and confirmed every specific claim in the rationale
  (which assertions run, what they check, what they do NOT check) is accurate and the point
  deductions are justified by what's actually missing (e.g. guest-viewing's 19/20 correctly docks
  one point for "never re-verifies the test itself made no change," guest-management's 18/20
  correctly docks two points for "verifies only through the same UI that just wrote it, no
  independent second read"). Nothing overstated, nothing invented.
- **unique-coverage (15/15 both)**: correctly full marks — see Finding 1 below for why this number
  is right today but was reachable via inconsistent logic for a case the real 2-test suite doesn't
  happen to exercise.
- **The 4 forced business-value criteria**: all four show `needsHumanReview: true`, 0 points, and a
  rationale naming exactly what's missing (`quality/requirements.yaml` has no priority field) — never
  a fabricated number, matching DEC-021's claim exactly.

## 2. Challenging duplicate/coverage/risk-weighted calculations with adversarial fixtures

Read `computeCoverage.spec.ts`/`detectDuplicates.spec.ts` first to avoid duplicating existing
coverage (both already test: requirement covered by both a healthy and an unhealthy test → not
flagged; an uncovered requirement's conservative risk weighting; multiple covering tests → highest
risk tier wins). This audit's own edge-case probing, beyond what those files already cover:

- **Risk dimension cardinality**: confirmed directly in `quality/tag-taxonomy.yaml` that `risk`, like
  `data-impact`, is `requirement: exactly-one` (not `at-least-one`) and is enforced by
  `tagValidation.ts` — so a real test can never actually have zero risk tags. `computeRiskWeightedCoverage`'s
  defensive fallback for a hypothetically-tagless test (treats it exactly like "uncovered," weight 4)
  is correct and conservative, consistent with DEC-022, even though it should be unreachable in
  practice.
- **Value-band boundary double-counting**: read `bandForValueScore` and `distributionOf` — both use
  `.find()` over non-overlapping, contiguous `[min, max]` ranges (90-100, 75-89, 50-74, 25-49, 0-24
  for both value bands and the quality-band bucketing). Exact boundary scores (90, 75, 50, 25) each
  match exactly one band; no double-count is possible.
- **Adversarial near-miss duplicate text**: this is where **Finding 1** (High, fixed) was caught —
  see below.

**Finding 1 (HIGH, FIXED) — `unique-coverage`'s overlap check used a different, undocumented
similarity threshold (0.3) from `detectDuplicates`'s own threshold (0.5), letting the two mechanisms
disagree about the exact same pair of tests.** `PLAYWRIGHT_TESTING.md` explicitly documents
unique-coverage as computed by "the same requirement + same data-impact tag + a shared feature tag +
objective-text similarity — see 'Duplicate detection' below, **which reuses the identical
comparison**." The code did not: `evaluateTest.ts`'s overlap filter called
`objectiveSimilarity(...) >= 0.3` while `detectDuplicates.ts`'s own `SIMILARITY_THRESHOLD` is `0.5` —
two independently-hardcoded numbers, not one shared constant. Reproduced live with a real,
adversarially-worded pair of synthetic objectives engineered to land in the gap (word-overlap
Jaccard similarity **0.4286**, verified by direct computation): sharing a requirement, the same
`@readonly` data-impact tag, and the same `@feature:guests` tag. Fed through the real
`detectDuplicates()` function, this pair was correctly **not** flagged (0 candidates, similarity
below 0.5) — but fed through the real `evaluateTestValue()` function, the SAME pair was treated as
"overlapping" (similarity above the drifted 0.3), reducing `unique-coverage` from 15 to 8 points
with a rationale literally naming the other test as sharing "requirement(s)... data-impact tag,
feature tag, and a similar objective." This is a self-contradictory report: one section says two
tests overlap enough to reduce one's uniqueness score, while another section, using the same
similarity number, explicitly declines to flag them as duplicates. The real 2-test suite never
exercises this gap only because `guest-viewing`/`guest-management` differ on data-impact tag
(filtered out before similarity is even checked), not because the threshold was ever actually
consistent — a future stage adding even one more `@readonly` guest test would have hit this
immediately. No existing unit test (`evaluateTest.spec.ts`'s unique-coverage block, or
`detectDuplicates.spec.ts`) exercised the 0.3–0.49 gap at all.
- **Fix**: exported `detectDuplicates.ts`'s `SIMILARITY_THRESHOLD` and made `evaluateTest.ts` import
  and use that single constant instead of a separately hardcoded `0.3`, so the two mechanisms can
  never drift apart again.
- **Re-verified live after the fix**: the same adversarial fixture pair now scores full 15/15 on
  `unique-coverage` (matching `detectDuplicates`'s "not a duplicate" finding), and the real 2-test
  suite's `pnpm pw:review` output is unchanged (still 20/22 value, exactly as before — this pair
  never touched the real suite's own scores).
- **Locking test**: new test in `evaluateTest.spec.ts`'s `unique-coverage` describe block, using the
  exact adversarial fixture pair above, first asserting `detectDuplicates` genuinely does not flag it
  (a sanity check that the fixture actually sits in the gap this finding exploited), then asserting
  `evaluateTestValue` agrees (full 15 points, no overlap language in the rationale). Confirmed this
  test fails against a temporarily-reverted pre-fix `evaluateTest.ts` (hardcoded `0.3`) — points
  drop to 8, exactly as the bug predicted — before trusting it as a lock.

## 3. Source references and exactly-once appearance

- **Discovery/catalog count**: `discoverAllApplicationTests` found exactly **2** tests
  (`guest-viewing.guest-list-shows-existing-guests`, `guest-management.add-guest-appears-in-list`);
  the generated `SuiteReview.tests` array has exactly 2 entries, no duplicates, `parseErrorCount: 0`.
- **Zero silently dropped**: confirmed by construction (`suiteReviewTests` is a 1:1 `.map()` over
  `discovered`) and directly inspecting the real generated JSON.
- **Following the actual source link in a real browser**: this is where **Finding 2** (High, fixed)
  was caught — see below.

**Finding 2 (HIGH, FIXED) — every suite-review test's source-file link 404'd when viewed the
documented way (`pnpm pw:review:serve`).** `renderSuiteReviewHtml.ts`'s `toHref` computes an href
relative to `artifacts/playwright/runs/suite-reviews` (3 directory levels below the repo root) for a
repo-root-relative path like `e2e/tests/guest-viewing.spec.ts`, producing
`../../../../e2e/tests/guest-viewing.spec.ts` (4 `..` segments). But a served suite-review page's own
URL is only 1 directory level deep (`/suite-reviews/<id>.html`), and a real browser's URL-resolution
algorithm can only "use" 1 of those 4 `..` segments before it runs out of path to pop and clamps at
the server's own URL root — landing on `/e2e/tests/guest-viewing.spec.ts`. `serve-suite-review.ts`'s
server root was `artifacts/playwright/runs`, which has no `e2e/` subdirectory at all, so this request
404'd. `PLAYWRIGHT_TESTING.md` explicitly documents `pw:review:serve` as serving the report "so its
links back to each test's source file resolve" — this claim was false. Reproduced live end to end:
started the real server (`pnpm exec tsx playwright-framework/cli/serve-suite-review.ts <reviewId>`),
opened the real generated HTML in a real headless Chromium, read both `.test-source a` hrefs,
resolved them against the page's own URL exactly as a browser would
(`new URL(href, page.url())` → `http://localhost:4301/e2e/tests/guest-management.spec.ts`), navigated
there, and got a real **404 "Not found"** for both test source links, confirmed both via full page
navigation and via `page.request.get()`.
- **Fix considered and rejected**: simply widening the server's root to the whole repo (so the 4
  `..` segments would have somewhere real to land) would also newly expose `.env` (present at this
  repo's root, confirmed by listing) and anything else at repo root through this unauthenticated
  local static file server — a worse problem than the one being fixed.
- **Fix shipped**: new `playwright-framework/reporting/servedPath.ts`, a pure, exported
  `candidatePathsForRequest()` that resolves a request first against the existing narrow
  `artifacts/playwright/runs` root (for the report's own JSON/HTML/screenshots/traces) and, only if
  that misses, against the repo root but restricted to an explicit allowlist of two directories that
  can legitimately contain test source (`e2e/`, `playwright-framework/`) — never the bare repo root.
  `serve-suite-review.ts` now uses this instead of its old single-root check.
- **Re-verified live after the fix**: restarted the real server with the fixed code; the same real
  browser test now gets a real **200** for both source links with the correct file content
  (confirmed the response body contains `defineQualityTest`, i.e. it's genuinely the right file, not
  an empty/wrong response) — via both full navigation and `page.request.get()` (full navigation to a
  `.ts` file triggers Chromium's own "Download is starting" behavior for an unrecognized MIME type,
  which is expected browser behavior for any raw source file server, not a defect in this fix).
  Separately re-confirmed `/.env`, `/../.env`, and a 6-level `../../../../../../etc/passwd` traversal
  attempt all still return **404** against the fixed server — the allowlist genuinely does not widen
  exposure beyond the two intended directories.
- **Locking tests**: new `playwright-framework/tests/servedPath.spec.ts` (6 tests) exercising the
  exact real 4-`..`-segment href shape, a `playwright-framework/` source path, the `.env` exclusion,
  and the traversal case. Confirmed 2 of the 6 fail against a temporarily-reverted pre-fix
  (single-root) version of the module before trusting them as a lock.

## 4. The report never presents unsupported AI judgment as fact

- Every `needsHumanReview: true` criterion renders as the literal text "NEEDS HUMAN REVIEW" in place
  of a points value in the HTML (`renderCriterionRow`), never `0/25` or any other number that could
  be misread as a real, low-but-calculated score — confirmed by reading the real rendered HTML for
  both tests' 4 forced business-value criteria.
- Both totals (value 20/100, 22/100, banded "Questionable") are shown alongside a "◐ Needs review"
  badge in both the collapsed summary and the expanded detail (the badge fires whenever either
  score's `provisional` flag is true, which is always true today on the value side per DEC-021) — a
  reader cannot see the number without also seeing the qualifier next to it.
- **Criterion-ID wiring against `quality/test-value-model.yaml`**: independently cross-checked every
  criterion ID and weight `evaluateTest.ts` emits against the model file — all 6 value criteria
  (business-criticality 25, user-impact-and-frequency 15, risk-and-defect-likelihood 20,
  security-compliance-data-integrity 15, unique-coverage 15, release-decision-usefulness 10) and all
  8 quality criteria (independence-and-parallel-safety 20, assertion-strength-and-objective-
  traceability 20, deterministic-waiting-and-state-control 15, page-component-object-and-locator-
  design 15, test-data-setup-and-cleanup 10, readability-and-diagnostic-steps 10, evidence-and-
  failure-diagnostics 5, metadata-completeness-and-standards-compliance 5) match exactly, no typos.
- **Does `computeScore`'s "unknown criterion" guard actually get exercised, or could a typo slip
  through?** Confirmed `computeScore.ts` throws `judgment references unknown criterion "..."` for
  any ID not in the live model (already covered by Stage 02's own `scoring.spec.ts`, pre-existing).
  Since a real `pnpm pw:review` ran to completion without this throwing, and every ID was
  independently cross-checked above, there is no live typo today — and the guard is proven to
  actually fire (not dead code) by the existing unit test.

## 5. Override, freshness-window, zero-test, and missing-governance-file behavior

All four exercised for real, not just read as code:

- **A real, temporary `quality/value-overrides.yaml` entry** (`criterion-score` override on
  `guest-viewing`'s `unique-coverage`, 15 → 10, reverted before this audit ends, confirmed via
  `git status`/`git diff` showing no residual change): regenerated the suite review, confirmed the
  JSON showed `total: 15` (20 − 15 + 10, correctly re-derived), `source: "override"`,
  `overrideRef` populated with the exact rationale/approver/date, and the HTML rendered the "Human
  override:" callout text.
- **`--freshness-window-days`**: temporarily isolated a single run-report file (backed up, edited its
  `endedAt` to 20 days in the past, moved every other real run-report file out of the directory,
  regenerated, confirmed both tests correctly showed `staleBeyondFreshnessWindow: true`,
  `ageDays: ~20`, and both appeared in the review queue with "outside the configured freshness
  window" reasons at priority 20 each — then fully restored every original run-report file
  byte-for-byte, confirmed via a diff against a pre-edit backup, and regenerated a clean review
  showing 0 queue items again).
- **Zero discovered tests**: moved `e2e/tests/` aside, ran `pnpm pw:review` directly — got a clear
  `No application tests discovered under e2e/tests -- nothing to review.` and exit code 1, no crash,
  then restored the directory.
- **Missing `quality/*.yaml` file**: moved `quality/test-evaluations.yaml` aside, ran `pnpm pw:review`
  — got `Suite review FAILED -- could not load governance files: ... could not read file: ENOENT ...`
  and exit code 1, no crash, then restored the file.

## Cleanup

Every scratch file used for live verification (`_scratch-audit-repro.spec.ts`,
`_scratch-audit-links.spec.ts`, `_scratch-audit-links2.spec.ts`, `_scratch-audit-visual.spec.ts`, a
`check-links.mjs` probe) was deleted immediately after use, never committed. The temporary
`quality/value-overrides.yaml` override and the temporarily-edited run-report `endedAt` were both
fully reverted, confirmed byte-for-byte against backups. The `serve-suite-review.ts` process started
during Finding 2's verification was killed and confirmed stopped (`curl` connection refused)
afterward. `git status --short` at the end of this audit shows only this report and the legitimate
Stage 07 fix files (`serve-suite-review.ts`, `detectDuplicates.ts`, `evaluateTest.ts`,
`evaluateTest.spec.ts` modified; `servedPath.ts`, `servedPath.spec.ts` new) — no scratch/probe files
remain, and nothing under `apps/`/`packages/`/application source was touched. One final, clean
suite review was regenerated after all fixes and left on disk (gitignored, per
`artifacts/playwright/**` in `.gitignore`) for reference.

## Verdict

**PASS WITH FINDINGS.** Every Stage 07 acceptance criterion and audit-gate item was independently
re-verified against the real discovered test suite and real generated reports, not trusted from the
implementation log: value/quality scores for both real tests were hand-traced criterion by criterion
against real lint output, real run-report data, and the hand-authored evaluation file's own rationale
text (all found honest and accurate); duplicate/coverage/risk-weighted arithmetic was challenged with
adversarial fixtures beyond the existing unit tests' coverage, which is exactly what surfaced Finding
1; every discovered test's source link was followed in a real browser against a really-served report,
which is exactly what surfaced Finding 2; no unsupported AI judgment was found presented as fact
anywhere in the rendered report; and the override, freshness-window, zero-test, and missing-file
paths were all exercised live and behave exactly as documented. Two High-severity bugs were found by
this audit — neither caught by the pre-existing 291-test suite — and fixed live with locking
regression tests, each confirmed to fail against its pre-fix code before being trusted: an
undocumented threshold mismatch that could make `unique-coverage`'s own rationale contradict the
duplicate-detection section for the exact same pair of tests; and every suite-review source-file
link being unreachable (404) through the framework's own documented, recommended way of viewing the
report. No Medium or Low findings are being carried forward this time — every additional edge case
this audit specifically went looking for (risk-tag cardinality, value-band boundaries, a requirement
covered by both a healthy and an unhealthy test, criterion-ID wiring, computeScore's unknown-ID
guard) held up under direct, live testing. Stage 07 may be marked complete on the Progress Dashboard.
