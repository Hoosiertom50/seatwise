# Stage 09 Audit

Result: PASS WITH FINDINGS (one High-severity classification-logic bug found and fixed live during this audit, with a locking regression test reproducing it against the pre-fix code; two Medium findings disclosed and left open, consistent with Stage 08's own precedent for non-blocking findings)
Auditor: Independent review subagent, fresh context with no memory of the implementation work, instructed to treat the code as unseen and to run real commands rather than trust the implementation log's prose.
Date/time: 2026-09-11
Repository is a git repo (working tree, no commits made by this audit).

## Scope

Verify Stage 09 (failure triage and controlled test repair) against
`PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`'s Section 10.4 (maintenance report requirements), Section 10.1
(shared report requirements), the Stage 09 task list/acceptance criteria/audit gate, DEC-027/DEC-028,
`PLAYWRIGHT_TESTING.md`'s Stage 09 section, and the precedent set by `quality/audits/stage-08-audit.md`.
The live app (`pnpm dev`, confirmed via `curl` returning 200 on `http://localhost:3000`) and its
Postgres 16 cluster (confirmed running via `ps aux`) were both already up, though this stage's own
verification needed only the framework's own CLIs and direct Playwright/hook invocations, never a
browser test against the live app itself. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` was exported for
every command. Every file named in the audit brief was read in full before any command was run.

## Files reviewed

- `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` Sections 10.1/10.4, the Stage 09 task list/acceptance
  criteria/audit gate, and the relevant Decision Log / Implementation Log rows (DEC-027, DEC-028).
- `PLAYWRIGHT_TESTING.md`'s "Failure triage and controlled test repair (Stage 09)" section, in full.
- `playwright-framework/metadata/schemas.ts` (`MaintenanceFindingSchema`/`MaintenanceReportSchema`
  and their `.refine()`, `FailureClassificationOverrideSchema`/`FailureClassificationsFileSchema`),
  `playwright-framework/metadata/loaders.ts` (`loadFailureClassifications`).
- `playwright-framework/triage/classifyFailure.ts` (in full, before and after this audit's own fix).
- `playwright-framework/cli/triage.ts`, `playwright-framework/cli/serve-maintenance-report.ts`.
- `playwright-framework/reporting/renderMaintenanceReportHtml.ts`,
  `playwright-framework/reporting/constants.ts`.
- `quality/failure-classifications.yaml`.
- `.claude/hooks/repair-write-guard.mjs` (`assessDiffRisk` and the maintenance-report `repairAllowed`
  re-check block, both in full), `.claude/hooks/post-edit-validator.mjs` (`isReviewRelevant`).
- `.claude/skills/{pw-triage-failures,pw-repair-test,pw-author-test}/SKILL.md`,
  `.claude/agents/{playwright-repair,playwright-triage}.md`.
- `playwright-framework/tests/{classifyFailure,maintenanceReportHtml,schemas,loaders}.spec.ts`,
  `playwright-framework/tests/hooks/{repairWriteGuard,postEditValidator,runHook}.spec.ts` (existing,
  read first to reuse the exact stdin-shaping harness and target genuine gaps rather than duplicate
  coverage; the first of these was edited by this audit).

## Verification commands run (numbers I personally observed, not taken from the log)

- `pnpm exec tsc --noEmit` — clean before, during (after the fix), and after this audit's own fix.
- `pnpm pw:validate` — `Total: 375 tests in 36 files` before this audit's own fix (matches the
  implementer's claim exactly); `Total: 377 tests in 36 files` after (2 new locking tests added into
  an existing file, `classifyFailure.spec.ts` — same file count).
- `pnpm pw:test` — **375/375 passed** before any fix (matches the implementer's claim exactly);
  **377/377 passed** after this audit's fix.
- A real, live end-to-end triage cycle: a genuine scratch failing test was written under
  `e2e/tests/`, run for real (`pnpm exec playwright test --project=chromium -g "scratch audit
  stage09"`), producing a real Stage 06 run report with `status: "consistent-failure"`; `pnpm
  pw:triage --run-id <id>` was then run for real against that exact run report multiple times, and
  the resulting `artifacts/playwright/maintenance/<reportId>.json` files were inspected directly.
- A real, direct zod parse (`MaintenanceFindingSchema.safeParse`, `FailureClassificationOverrideSchema
  .safeParse`) against adversarially-constructed documents, run via `tsx` — not just read and
  assumed.
- Dozens of direct, real invocations of `repair-write-guard.mjs` and `post-edit-validator.mjs` with
  the exact stdin shape `runHook.ts`'s own harness uses, both against throwaway fake repository roots
  under this session's own scratchpad directory (never this repo's own files, for the adversarial
  hook cases) and against this real repository's own real files (for the `post-edit-validator.mjs`
  relevance-scoping checks, which legitimately run real `tsc`/`pw:review` against real repo state).
- `git status --short` at the end — only the legitimate Stage 09 implementation files (now including
  this audit's fix inside `playwright-framework/triage/classifyFailure.ts` and its locking tests in
  `playwright-framework/tests/classifyFailure.spec.ts`) plus this report; no scratch/probe files
  remain (see "Cleanup" at the end).

## 1. Re-running the baseline myself, not trusting the ledger

Before touching anything: `pnpm exec tsc --noEmit` clean, `pnpm pw:validate` reported `Total: 375
tests in 36 files`, and `pnpm pw:test` reported `375 passed (54.1s)` — all three match Section 4's
claim exactly, independently re-derived rather than copied from the log.

## 2. Adversarial scenarios: can the classifier/schema be tricked into marking a real defect as repairable?

Read `MaintenanceFindingSchema`'s `.refine()` and `classifyFailure.ts`'s hand-authored-tier clamp,
then tested both for real rather than trusting the reading.

**Schema-level `.refine()`, tested directly with a real zod parse (not read-and-assumed):**

```
MaintenanceFindingSchema.safeParse({ classification: "probable-application-defect", repairAllowed: true, ... })
  -> success: false, issue: "repairAllowed must be false whenever classification is
     probable-application-defect or insufficient-evidence" (path: repairAllowed)
MaintenanceFindingSchema.safeParse({ classification: "insufficient-evidence", repairAllowed: true, ... })
  -> success: false, same issue
MaintenanceFindingSchema.safeParse({ classification: "probable-test-defect", repairAllowed: true, ... })
  -> success: true (the legitimate case still passes)
```

**The hand-authored-tier clamp in `classifyFailure.ts`, tested with a real, end-to-end triage run --
not a unit-test fixture.** `FailureClassificationOverrideSchema` (the schema `quality/
failure-classifications.yaml` entries are validated against) has **no** equivalent `.refine()` --
confirmed with a real parse: an entry claiming `classification: "probable-application-defect"` and
`repairAllowed: true` parses successfully at the YAML-loader level. This is disclosed as intentional
in the implementer's own module comment (`classifyFailure.ts` is "the single place responsible for
upholding [the invariant]"), so I tested whether that claim actually holds at the point where it
matters -- the real, on-disk maintenance report a human or `/pw-repair-test` would actually read.

Added a real entry to `quality/failure-classifications.yaml` (scratch, removed before this audit
ended) for a genuinely failing scratch test's real `testId`, claiming `classification:
"probable-application-defect"`, `repairAllowed: true`. Ran `pnpm pw:triage --run-id <id>` for real:

```
$ pnpm pw:triage --run-id 94d75cd8-...
1 failure(s) triaged.
  probable-application-defect: 1
0 finding(s) are repair candidates (still require explicit human confirmation via /pw-repair-test).
```

Inspected the written JSON directly: `"repairAllowed": false, "repairAllowedFiles": [], "source":
"hand-authored"` -- the malicious override's `repairAllowed: true` was silently clamped to `false`
by `classifyFailure.ts` before the document was ever constructed, so the schema-level `.refine()`
never even had anything to reject. Repeated with `classification: "insufficient-evidence"` +
`repairAllowed: true` -- same result: clamped to `false`. Both categories hold. This is genuine
defense-in-depth, verified working end-to-end rather than merely claimed: the YAML loader's own
permissiveness on this specific invariant is real, but it is provably inert because the one place
that turns a hand-authored entry into a `MaintenanceFinding` never trusts it on this field.

## 3. Confidence honesty and ambiguous-evidence handling

Read `classifyFailure.ts`'s four branches and confirmed each `confidence` value's provenance rather
than assuming it:

- Mechanical tier 1 (environment/infrastructure): hardcoded `"high"` -- justified, since this branch
  only fires on a structural fact (`status === "setup-failure"`) or a matched, enumerated regex
  signature, not a guess.
- Mechanical tier 2 (intermittent/flaky): hardcoded `"medium"` -- justified as "suggestive, not
  conclusive" in the finding's own `recommendedNextAction` text, and, after this audit's fix (Section
  4 below), tied to a real recency requirement rather than an arbitrarily old data point.
- Hand-authored tier: taken directly from the human/AI-authored `quality/failure-classifications.yaml`
  entry's own `confidence` field -- the author's judgment, not a framework-invented number.
- Fail-closed default (`insufficient-evidence`): hardcoded `"low"` -- correct, since this is the "we
  genuinely don't know" case by construction.

None of these is "a hardcoded constant regardless of evidence quality" in the pejorative sense the
audit brief warns about -- each is tied to which real signal fired, and the two mechanical constants
reflect genuinely different certainty levels for genuinely different signal types.

**Fail-closed default, tested directly (not read-and-assumed):** ran the real scratch failure (no
mechanical signal, no `quality/failure-classifications.yaml` entry) through `pnpm pw:triage` for
real. Result: `classification: "insufficient-evidence"`, `confidence: "low"`,
`needsHumanReview: true`, `repairAllowed: false`, `evidenceForApplicationDefect: []`,
`evidenceAgainstApplicationDefect: []` (both sides genuinely empty, not fabricated) --
`recommendedNextAction` correctly tells a human to add a hand-authored entry rather than guessing.
This is a true fail-closed default, not a silent fallthrough to something else, and not a thrown
exception.

## 4. Finding (High, FIXED) — a real, ongoing, deterministic application regression could be mechanically misclassified as "intermittent/flaky" (repairAllowed: true) from a single arbitrarily-old historical pass

**Root cause.** `classifyFailure.ts`'s mechanical tier 2 read:

```js
const hasPassedElsewhere = otherOutcomes.some((o) => PASSING_STATUSES.has(o.status));
const hasFailedElsewhere = otherOutcomes.some((o) => FAILING_STATUSES.has(o.status));
if (hasPassedElsewhere && (hasFailedElsewhere || FAILING_STATUSES.has(test.status))) { ... }
```

`classifyFailure` is only ever invoked on an already-failing test (`triage.ts` pre-filters to
`FAILING_STATUSES`), so `FAILING_STATUSES.has(test.status)` in that condition is **always true by
construction** -- the entire mechanical signal therefore collapsed to just `hasPassedElsewhere`:
"this test passed at least once, ever, in any run report on file, however old." That is the opposite
of what "intermittent/flaky" is supposed to mean, and it matters here specifically because
`intermittent-flaky-behavior` sets `repairAllowed: true` -- routing a genuine, ongoing regression
toward the controlled-repair workflow instead of `probable-application-defect`/hand-authored review,
directly undermining this stage's own acceptance criterion: "A probable application bug remains
visible and is not 'fixed' by changing the test." This is exactly the audit brief's "tempt the
repair workflow into hiding a real defect" scenario, and it was findable with the existing unit
suite's own fixtures -- the pre-existing tests only ever constructed a single earlier report, never
a realistic history with an old pass followed by several genuinely consecutive recent failures.

**Reproduced live**, via a real `classifyFailure()` call (not a hypothetical): a test that passed
once in a report dated `2026-03-01`, then failed deterministically in four more real run reports
dated `2026-09-05` through `2026-09-08`, then failed again in the run being classified
(`2026-09-11`) -- a textbook ongoing regression, not flakiness --

```
classification: intermittent-flaky-behavior
repairAllowed: true
needsHumanReview: true
```

**Fix.** Replaced the "any historical pass, however old" signal with a genuine recency-based
oscillation check: the run **chronologically nearest in the historical record** (the most recent
*other* run on file, by `endedAt`) must itself be a pass. This is still a purely structural,
mechanical fact about run history (no semantic guessing), but it actually distinguishes "this test
was healthy as recently as its last other recorded run, and is failing now" (real flake-like
oscillation) from "this test has been failing in every run since some ancient, one-off pass" (a real
regression). Re-verified live with the same reproduction: classification is now
`insufficient-evidence`, `repairAllowed: false` -- correctly routed to human review with repair
blocked, rather than silently handed to the repair-eligible path. The existing genuine-flake case (a
test whose *immediately preceding* run actually passed) still classifies as
`intermittent-flaky-behavior`, `repairAllowed: true` -- confirmed unchanged.

**Locking test**, added to `playwright-framework/tests/classifyFailure.spec.ts`: one test
reproducing the exact ancient-pass-then-ongoing-regression scenario above (asserts `classification
!== "intermittent-flaky-behavior"` and `repairAllowed === false`), one companion test confirming the
genuine-oscillation case still classifies as flaky and repairable. Confirmed the new locking test
fails against the pre-fix code: the fix was temporarily reverted in place (the exact pre-fix
condition, restored from a saved copy immediately after), the spec file re-run, and the new test
failed exactly as expected (`Expected: not "intermittent-flaky-behavior"`, actual:
`"intermittent-flaky-behavior"`) while the other 12 tests in the file still passed; the fix was then
restored and the file re-run clean at 13/13.

## 5. Repair write-scope and human-approval requirements (`repair-write-guard.mjs`)

Used `runHook`'s own real stdin-shaping approach (spawns the real `node .claude/hooks/
repair-write-guard.mjs` process with real JSON on stdin) against throwaway fake repository roots,
never this repo's own files.

**`assessDiffRisk` — every risk category tested directly and independently, each correctly denied:**

| Risk category | Real Edit-shaped input | Result |
|---|---|---|
| `assertion-count-decrease` | drop an `expect(...)` call | denied |
| `new-fixed-wait` | introduce `.waitForTimeout(...)` | denied |
| `new-skip-only-or-fixme` | change `test(...)` to `test.skip(...)` | denied |
| `new-raw-selector-in-test` | replace a page-object call with `page.locator(...)` inside a test spec | denied |
| `page-object-or-component-change` | ANY edit at all to a file under `e2e/pages/` | denied |

`justifiedExceptions` escape hatch tested directly: the same `assertion-count-decrease` edit, with a
matching `{category: "assertion-count-decrease", reason: "..."}` entry in `repair-scope.json`, was
correctly `allow`ed.

**The maintenance-report `repairAllowed` re-check, and its edge cases -- probed directly rather than
assumed:**

- **Multiple maintenance report files on disk**: constructed two, with deliberately different
  `mtime`s and opposite `repairAllowed` verdicts for the same test. The hook correctly picked the
  file with the later `mtimeMs` (confirmed by setting the older file's mtime backward with
  `utimesSync`) and denied because the *newer* file said `repairAllowed: false` -- fails toward the
  most current classification, not an arbitrary one.
- **Evidence-link path mismatches**: tested a case-differing path (`T.spec.ts` vs. `t.spec.ts`), a
  path with a leading `./`, and an absolute path in the evidence link, each against an edit targeting
  the real, correctly-cased/relative path. All three **failed closed (denied)** -- the hook does no
  path normalization on either side of the comparison, so any of these mismatches is treated as "no
  matching finding" and denied outright, never silently treated as a match. This is the safe
  direction; a real `pw:triage` output and a real edit's `file_path` will always agree exactly in
  practice (both derive from the same repo-relative, forward-slash-normalized convention), so this
  strictness costs nothing in the honest-usage path while closing off any possibility of a
  string-mismatch bypass.

No bypass of the write-scope or approval mechanism was found in `repair-write-guard.mjs` itself --
every adversarial case held, matching (and, for the maintenance-report gate specifically, extending)
Stage 08's own prior symlink-defense fix, which remains intact and was re-confirmed present and
unchanged in this file.

## 6. Suite review automatically follows test modification (`post-edit-validator.mjs`)

Invoked the real hook script directly against real paths in this repository (not a fake root, since
this validator legitimately runs real `tsc`/`pw:review` against real repo state, matching the
existing spec file's own precedent):

- **Correctly triggers `pnpm pw:review`** for: `e2e/fixtures/index.ts`, `e2e/pages/BasePage.ts`,
  `e2e/components/GuestRow.ts`, `playwright-framework/coverage/runReportHistory.ts`,
  `playwright-framework/scoring/types.ts` (all confirmed via the hook's own `systemMessage` output
  naming `pnpm pw:review` as one of the checks that ran and passed).
- **Correctly does NOT trigger `pnpm pw:review`** for `e2e/support/auth.ts` and `e2e/data/ids.ts` --
  both are framework `.ts` files (so `tsc --noEmit` alone runs) but are deliberately excluded from
  the review-relevant set, matching `quality/repair-allowed-dirs.yaml`'s own distinction between
  shared test infrastructure and a test's own governed artifacts.
- **Correctly no-ops entirely** for `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`, `PLAYWRIGHT_TESTING.md`,
  and `README.md` (this very spec file included) -- `"...is not a test, page-object, metadata,
  reporter, or framework file -- nothing to check"`, exit 0, no output.

This exactly matches the implementer's own claimed category list (test/page-object/component/
fixture/governance-yaml/scoring-evaluation-coverage) with no over- or under-inclusion found in
either direction.

## 7. Schema/classification correctness against Section 10.4 itself

- **All 7 Section 10.4 categories present with the exact strings**: confirmed directly in
  `FailureClassificationSchema`'s enum (`probable-application-defect`, `probable-test-defect`,
  `intended-application-change`, `test-data-problem`, `environment-or-infrastructure-problem`,
  `intermittent-flaky-behavior`, `insufficient-evidence`) -- matches Section 10.4 verbatim.
- **Section 10.4's 12 per-failure fields are all present** on `MaintenanceFindingSchema`, but the
  Implementation Log's claim that "All 12 Section 10.4 fields are non-optional... schema-enforced,
  not just convention" is not literally accurate: `firstFailedStep` and `suggestedDefectDescription`
  are both `z.string().optional()`, confirmed by a real zod parse that succeeds with both fields
  omitted entirely. This is disclosed as a documentation-accuracy finding (Medium), not a functional
  defect -- both fields are legitimately conditional per Section 10.4's own wording ("first
  meaningful failed step" doesn't exist for a failure with no recorded step data; "suggested defect
  description **when** an application bug is probable" is explicitly conditional in the spec's own
  text) -- but the Section 4 prose overclaims what the schema actually enforces and should be
  corrected to say "10 of 12 are non-optional; the remaining 2 are conditionally present per Section
  10.4's own wording" rather than "all 12."
- **Consistency with `RunReportSchema`/`SuiteReviewSchema`**: both of those schemas carry `gitCommit`
  and `workingTreeClean` fields (Section 10.1: "Include generation time, framework version,
  repository, Git commit, and working-tree state" -- a requirement for *every* report, not just
  Stage 06/07's). `MaintenanceReportSchema` has `generatedAt` and `frameworkVersion` but **no
  `gitCommit`/`workingTreeClean` fields at all**, and `renderMaintenanceReportHtml.ts` correspondingly
  never renders a Git commit or working-tree-state line, unlike `renderRunReportHtml.ts` and
  `renderSuiteReviewHtml.ts`, which both do. This is a real, verified inconsistency with the
  established pattern Stage 09 was supposed to follow (Medium finding, disclosed and left open --
  see "Findings left open" below).
- **`repairAllowed` schema-level invariant**: re-verified in Section 2 above with a real zod parse,
  not merely read.

## 8. Visual-baseline-update prohibition (N/A claim)

Ran my own repo-wide grep rather than trusting the claim:

```
$ grep -rn "toHaveScreenshot\|toMatchSnapshot\|--update-snapshots" --include="*.ts" --include="*.md" \
  --include="*.json" --include="*.yaml" --include="*.yml" --include="*.mjs" .
```

Zero real matches -- the only hits are the disclosure text itself in `PLAYWRIGHT_TESTING.md` and
`PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` quoting the check. Confirmed N/A, honestly disclosed rather
than silently skipped.

## Findings left open (Medium, disclosed, not fixed live)

Per this framework's own precedent (Stage 08's audit left non-blocking findings open) and the audit
brief's own instruction that only High-or-above findings require a live fix, the following two are
disclosed rather than fixed in this session:

1. **`MaintenanceReportSchema` lacks `gitCommit`/`workingTreeClean`**, unlike its `RunReportSchema`/
   `SuiteReviewSchema` siblings and Section 10.1's own blanket requirement (Section 7 above). Fixing
   this would mean adding both fields to the schema, threading real `git rev-parse`/`git status`
   output through `triage.ts` (mirroring `suite-review.ts`'s own `gitInfo()` helper exactly), and
   rendering a "Git commit" row in `renderMaintenanceReportHtml.ts` -- a real but non-trivial change
   across three files, not a one-line fix, and not itself a repair-hiding or write-scope-bypass risk
   (the two things this audit was told to fix live on sight). Left for a human decision on whether to
   thread this through now or accept a documented, disclosed gap in this one report type.
2. **The hand-authored tier does not force `needsHumanReview: true`** for `probable-application-
   defect`/`insufficient-evidence` the way it forces `repairAllowed: false` for the same two
   categories -- a `quality/failure-classifications.yaml` entry can set `needsHumanReview: false` on
   an `insufficient-evidence` or `probable-application-defect` finding (verified live: both of my
   scratch adversarial entries above produced `needsHumanReview: false` in the final report). This
   does **not** let a repair proceed (repairAllowed is still unconditionally clamped `false` for both
   categories, verified in Section 2), so it is not a repair-hiding bypass -- but it could let a real
   application defect's maintenance-report entry render with a "No further review flagged" badge
   instead of "Needs human review," which is a plausible way for a human skimming the report to miss
   it. Left open as Medium rather than fixed live because it does not meet the audit brief's specific
   bar for a mandatory live fix (no write-scope/approval bypass, no path to an actual repair); the
   defensible fix (clamp `needsHumanReview` the same way `repairAllowed` already is, for these two
   categories) is a small, mechanical change a human can make in a follow-up pass.

Both are genuine, verified (not hypothetical) gaps, not merely theoretical -- reported here rather
than silently omitted per this audit's own standard.

## Cleanup

Every adversarial probe against `repair-write-guard.mjs` ran against a throwaway fake repository
root under this session's own scratchpad directory (`/tmp/.../scratchpad`), created and destroyed
per scenario, never this repo's own files. The one real end-to-end triage walkthrough used a genuine
scratch failing test (`e2e/tests/zzz-scratch-audit-stage09.spec.ts`) and a genuine scratch entry
added to the real `quality/failure-classifications.yaml` -- both were deleted / reverted to the
committed-intent content (`classifications: []`) before this audit ended. The scratch test's run
reports (`94d75cd8-...`, `d998a6b7-...`) and the maintenance reports generated from them
(`59d7efda-...`, `bc29556c-...`, `f8605dbd-...`) were individually deleted by ID; one unrelated,
pre-existing maintenance report (`9e149a44-...`, timestamped before this audit began, `frameworkVersion:
"0.8.0"`, empty findings) was left untouched, confirmed not to reference the scratch test. The
`classifyFailure.ts` fix was temporarily reverted in-place to confirm the new locking test genuinely
fails against the pre-fix logic, then restored from an in-memory backup and re-verified byte-for-byte
identical to the intended fix before trusting it; the full suite was re-run clean after restoration.
`git status --short` at the end shows only the legitimate Stage 09 implementation files (the fix
inside `playwright-framework/triage/classifyFailure.ts`, its locking tests in
`playwright-framework/tests/classifyFailure.spec.ts`, both already part of this stage's untracked
deliverables) plus this report -- no scratch/probe files remain.

## Verdict

**PASS WITH FINDINGS.** Every Stage 09 acceptance criterion and audit-gate item was independently
re-verified with real commands, real zod parses, and real (fake-root-isolated where appropriate)
adversarial hook invocations -- not trusted from the implementation log. The claimed test counts
matched exactly before any fix (375/375). The three-layer `repairAllowed: false` defense for
`probable-application-defect`/`insufficient-evidence` (schema `.refine()`, `classifyFailure.ts`'s own
clamp, and `repair-write-guard.mjs`'s independent maintenance-report re-check) was tested at every
layer with real adversarial inputs and held in every case. `assessDiffRisk`'s five risk categories and
its `justifiedExceptions` escape hatch were each tested directly and behaved correctly, including
under multi-report and path-mismatch edge cases, all of which fail closed. `post-edit-validator.mjs`'s
`isReviewRelevant` correctly scopes `pnpm pw:review` triggering to exactly the claimed file
categories, with no over- or under-inclusion found.

One High-severity bug was found by this audit's own adversarial probing -- not caught by the
pre-existing 375-test suite, and not found by reading the code alone, only by constructing a
realistic multi-run history and running the real classifier against it: mechanical tier 2's
"intermittent/flaky" signal could mechanically misclassify a genuine, ongoing, deterministic
application regression as flaky-and-repairable from a single arbitrarily-old historical pass, since
the condition's second clause was always true by construction for any failing test. Fixed live with
a recency-based oscillation requirement, re-verified against the original adversarial repro (now
correctly falls to `insufficient-evidence`, `repairAllowed: false`) and against the genuine-flake
case (still correctly classified as flaky and repairable), with a locking regression test confirmed
to fail against the pre-fix code and pass after. `pnpm exec tsc --noEmit`, `pnpm pw:validate`
(`Total: 377 tests in 36 files`), and `pnpm pw:test` (**377/377 passed**) were all re-run clean after
the fix. Two Medium findings (a schema-consistency gap with `RunReportSchema`/`SuiteReviewSchema` on
`gitCommit`/`workingTreeClean`, and an un-clamped `needsHumanReview` for the same two forced-no-repair
categories) are disclosed and left open, per this framework's own established precedent for
non-blocking findings, since neither constitutes a repair-hiding or write-scope-bypass risk on its
own. No scratch artifacts remain; `git status --short` confirms only the legitimate implementation
and fix files plus this report.
