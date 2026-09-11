# Reusable Playwright Quality Engineering Framework

## Implementation specification and resumable build plan for Claude Code

**Specification version:** 1.0  
**Specification status:** Ready for implementation  
**Intended executor:** Claude Code operating inside an application repository  
**Primary users:** Manual testers beginning Playwright automation, automation engineers, developers, and human test reviewers  
**Default implementation language:** TypeScript  
**Last specification review:** 2026-09-09

---

## 1. Purpose

Build a reusable, mature Playwright testing environment inside an existing application repository. The environment must help a manual tester author reliable automated tests, select tests through a controlled tagging system, run them safely, understand results through human-readable HTML reports, evaluate the value and quality of every test, diagnose failures, and maintain tests without concealing application defects.

This file is both:

1. The implementation specification.
2. The persistent implementation ledger used by Claude Code to resume interrupted work.

The implementation must use Playwright's native capabilities where they fit, including Playwright Test, annotations and tags, fixtures, projects, page-object models, reporters, screenshots, traces, retries, and test isolation. Custom code should extend Playwright rather than replace it.

---

## 2. Instructions to the implementing agent

### 2.1 Mandatory operating contract

- [ ] Read this entire specification before changing files.
- [ ] Inspect the target repository and complete the Project Profile in Section 5.
- [ ] Reuse compatible project conventions instead of creating competing structures.
- [ ] Preserve all existing application behavior and unrelated user changes.
- [ ] Do not modify application source code merely to make an automated test pass.
- [ ] Do not run data-modifying tests against production.
- [ ] Use the repository's existing package manager and lockfile unless a recorded decision authorizes a change.
- [ ] Treat each unchecked checkbox as unfinished unless evidence proves otherwise.
- [ ] Check a task only after implementing it and recording objective verification evidence.
- [ ] Update the Implementation State in Section 4 before ending every work session.
- [ ] Complete and pass the audit at the end of each stage before starting the next stage.
- [ ] If an audit fails, uncheck affected completion items, correct the findings, rerun verification, and repeat the audit.
- [ ] If blocked, record the blocker and a precise next action; do not check blocked work as complete.
- [ ] Keep generated reports and run artifacts out of source control unless the target repository explicitly requires versioned report examples.
- [ ] Never weaken, remove, skip, or broadly rewrite a test simply to obtain a green result.
- [ ] Stop and ask the human when an expected behavior, production-safety decision, credential requirement, or destructive action is ambiguous.

### 2.2 Resume protocol

Whenever implementation begins or resumes:

1. Read Sections 2 through 5 and the Progress Dashboard.
2. Inspect `git status` and preserve unrelated changes.
3. Locate the first stage that is not marked complete.
4. Verify that the latest completed stage still has its audit artifact and passing evidence.
5. Read the last session entry and open blockers in the Implementation Log.
6. Continue at the first unchecked task whose prerequisites are satisfied.
7. Before stopping, update Current Stage, Last Verified Task, Blockers, Decisions, and the Implementation Log.

Do not restart completed work merely because a new Claude Code session has started. Do not trust checkmarks blindly when referenced files or evidence are missing.

### 2.3 Stage-gate rule

A stage is complete only when all of the following are true:

- Every required task in the stage is checked.
- Every stated acceptance criterion passes.
- Verification commands have been run successfully.
- The stage audit exists at `quality/audits/stage-<NN>-audit.md`.
- The audit result is `PASS`.
- Every audit finding is resolved or explicitly accepted by the human with a recorded rationale.
- The stage's Progress Dashboard row is checked.

The agent that performs an audit should be logically independent from the implementation work. Use the read-only Playwright reviewer subagent once it exists. Before that agent exists, start a fresh review context, adopt an adversarial reviewer posture, and do not rely only on the implementation summary.

---

## 3. Desired outcomes

The completed framework shall provide:

1. Independent, deterministic, maintainable Playwright tests written in TypeScript.
2. Centralized selectors and business actions through page and component objects.
3. Typed fixtures for authentication, test data, environment configuration, and evidence capture.
4. A governed tag taxonomy and a friendly runner supporting AND, OR, and NOT tag expressions.
5. Safe separation between read-only and data-modifying tests.
6. A templated HTML test-run report describing what passed, failed, retried, or was skipped and why.
7. Screenshots at meaningful successful validation checkpoints and automatically on failures.
8. Traces and diagnostic evidence for failures and retry attempts.
9. A templated HTML suite-review report covering requirements, risks, gaps, and every discovered test.
10. A visible, versioned definition of a highly valuable test used consistently to score every test.
11. Separate 0–100 value and implementation-quality scores for every test.
12. A templated HTML maintenance report that classifies failures and recommends action.
13. A guarded workflow that repairs individual defective tests without hiding software bugs.
14. Claude Code project skills, slash-command workflows, focused subagents, and narrowly scoped hooks.
15. Documentation suitable for a manual tester with limited programming experience.
16. Deterministic framework validation, automated self-tests, and CI integration.

---

## 4. Persistent implementation state

The implementing agent must maintain this section throughout the build.

**Current stage:** 10 (complete)  
**Current task:** Begin Stage 11 — Final system audit and handoff  
**Last verified task:** Implemented the full Stage 09 failure-triage and controlled-repair system: replaced
the stale, unused Stage 02 placeholder schema with a real Section-10.4-compliant
`MaintenanceFindingSchema`/`MaintenanceReportSchema` (DEC-027, confirmed dead via `grep -rln` before
deletion); built `classifyFailure.ts` implementing DEC-028's mechanical/hand-authored/fail-closed
classification tiers (mirroring DEC-021's precedent exactly — only
`environment-or-infrastructure-problem` and `intermittent-flaky-behavior` are computed mechanically;
the other four categories require a `quality/failure-classifications.yaml` entry or default to
`insufficient-evidence`); built the `pnpm pw:triage` CLI (reads an existing run report by ID, never
reruns), `renderMaintenanceReportHtml.ts`, and `pnpm pw:triage:serve`; extended `repair-write-guard.mjs`
with two new independent mechanisms — a coarse regex-based `assessDiffRisk` diff-safety proxy gated on
`repair-scope.json`'s new `justifiedExceptions`, and (self-identified as a gap, not audit-driven) an
independent re-derivation of `repairAllowed` from the actual on-disk maintenance report, matched by its
"Test source" evidence-link path — giving "prohibit repair for probable application defects and
insufficient-evidence outcomes" three independent enforcement layers (schema `.refine()`,
`classifyFailure.ts`'s own clamping, and this hook re-check) rather than one; extended
`post-edit-validator.mjs` so any test/page-object/component/fixture/governance-yaml/scoring-evaluation
change also triggers `pnpm pw:review`; updated the `pw-triage-failures`/`pw-repair-test`/`pw-author-test`
skills and the `playwright-repair`/`playwright-triage` agent docs; bumped `FRAMEWORK_VERSION` to
`"0.9.0"`. Added 23+11+11+9+1+4 = 59 new/updated tests across 6 files (`classifyFailure.spec.ts`,
`maintenanceReportHtml.spec.ts`, `repairWriteGuard.spec.ts`, `postEditValidator.spec.ts`,
`schemas.spec.ts`, `loaders.spec.ts`) plus fixes to 2 pre-existing tests whose fixtures/assertions no
longer matched the new behavior (a repair-write-guard fixture whose `old_string` didn't actually appear
in its own fixture content; a post-edit-validator assertion string that no longer matched the new
combined validator-check message). Performed real end-to-end live verification mirroring Stage 06's
precedent: a temporary scratch test was written to induce a real failure, run for real, triaged for
real (`pnpm pw:triage`), served for real (`pnpm pw:triage:serve` + `curl`/browser check, including
confirming the report's "Test source" link resolves via a direct `curl` 200 even though the browser
itself attempts a download rather than inline navigation for `.ts` — a pre-existing characteristic
shared with Stage 07's `serve-suite-review.ts`, not a Stage 09 regression), and a real attempted edit
against a scratch `probable-application-defect` finding's named test file was denied live by the
extended hook — then every scratch artifact (spec file, run/maintenance reports, `repair-scope.json`)
was deleted and `git status --short` confirmed clean of them before any ledger update. Ran the complete
validation suite last: `pnpm exec tsc --noEmit` clean, `pnpm pw:validate` clean, `pnpm pw:test` —
**375/375 passed**. Documentation updated on all four surfaces: `PLAYWRIGHT_TESTING.md` (extended hook
sections, new "Failure triage and controlled test repair (Stage 09)" section), `README.md` (Layout
bullet extended, new Stage 09 bullet, "as of Stage 09"), and the five skill/agent files above  
**Last verified task:** Independent Stage 09 audit (fresh context, no memory of the implementation)
completed and PASSED WITH FINDINGS, then independently re-verified by the orchestrating session
itself (not merely trusted) before this ledger update. The audit's baseline re-check matched exactly
(375/375 pre-fix, `Total: 375 tests in 36 files`), then found one real, previously-uncaught
High-severity bug via its own adversarial history construction (not the pre-existing 375-test suite):
`classifyFailure.ts`'s mechanical "intermittent/flaky" tier could misclassify a genuine, ongoing,
deterministic application regression as flaky-and-repairable from a single arbitrarily-old historical
pass, because `classifyFailure` is only ever invoked on an already-failing test, making the old
condition's second clause always-true by construction — the entire signal collapsed to "a pass
exists somewhere in history, however old." Fixed live by requiring the MOST RECENT other run on file
to itself be a pass (a genuine recency-based oscillation signal), with a locking test reproducing the
exact regression scenario and a companion test confirming genuine flakiness still classifies
correctly. **The orchestrating session independently re-verified this rather than trusting the
audit's report**: read `classifyFailure.ts` in full and confirmed the described bug and fix match the
actual code; temporarily reverted the fix in place and re-ran the new locking test directly, which
genuinely failed pre-fix (`Expected: not "intermittent-flaky-behavior"`) exactly as claimed; restored
the fix and independently re-ran the full suite (**377/377 passed**, `pnpm exec tsc --noEmit` clean,
`Total: 377 tests in 36 files`) rather than reusing the audit's own numbers; and independently
inspected `schemas.ts` directly to confirm both disclosed Medium findings are real: `firstFailedStep`
and `suggestedDefectDescription` are genuinely `.optional()` on `MaintenanceFindingSchema` (so the
Implementation Log's "all 12 fields non-optional" claim overstated the schema by two conditionally-
present fields), and `MaintenanceReportSchema` genuinely has no `gitCommit`/`workingTreeClean` fields
unlike `RunReportSchema`/`SuiteReviewSchema`. Every adversarial repair-write-guard/post-edit-validator
scenario the audit ran (all 5 `assessDiffRisk` risk categories, the `justifiedExceptions` escape
hatch, multi-report-by-mtime resolution, evidence-link path-mismatch fail-closed behavior, the
`isReviewRelevant` scoping in both directions) held with no bypass found. `git status --short`
confirmed clean of scratch artifacts both after the audit and after this session's own independent
re-verification steps. See `quality/audits/stage-09-audit.md` for full detail  
**Last verified task:** Implemented the full Stage 10 CI/documentation/operational-hardening system:
three GitHub Actions workflows (`.github/workflows/{ci,scheduled-regression,weekly-quality-review}.yml`)
— a PR/push gate (typecheck+metadata+lint+framework-unit-tests gating a 2-shard application E2E run
against a real Postgres service container and a real built app, then a merged HTML report), a
nightly regression re-run, and a weekly flaky re-check + suite-review regeneration. Added explicit
CI-appropriate `timeout`/`expect.timeout`/`globalTimeout` to `playwright.config.ts`. Built
`playwright-framework/cli/ci-summary.ts` (pure logic in `playwright-framework/reporting/
ciSummary.ts`, 8 unit tests) after discovering LIVE (not assumed) that `playwright test` exits 0 for
both a zero-match `--grep` and an empty `--shard` — this script reads the run report those cases
still produce and turns a genuine zero-test run into a hard CI failure while surfacing a flaky/
quarantined/failed result via `$GITHUB_STEP_SUMMARY` + `::warning::`/`::error::` annotations, so
none of those can look like an ordinary clean pass (verified live for all four cases: clean pass,
zero-test, induced flaky, and real failures). Built `playwright-framework/cli/print-ci-selection.ts`
so CI's sharded run gets the exact same test selection `pnpm pw:run --selection regression --list`
would show (reusing the same `evaluateExpression`/`compileToGrepPattern` primitives) without
widening Stage 05's own audited `pw:run` to accommodate sharding/multi-reporter needs it wasn't
designed for (DEC-030) — verified live: identical matched files/tests to `pw:run`'s own preview, and
a real 2-shard run + `playwright merge-reports` genuinely combined both shards into one HTML report.
Completed `PLAYWRIGHT_TESTING.md` with 11 new sections for a manual tester (first-test tutorial,
tagging cheat sheet, common commands, report-review guide, good/bad examples tied directly to
`pw:lint-tests`'s real rules, a new fillable `quality/manual-test-to-automation-worksheet.md`,
adding requirements/tags/page-objects/fixtures/test-data, updating the value model, report
retention/cleanup, CI/sharding/report-merging, framework upgrade/compatibility) and extended
`README.md`. Four new decisions recorded (DEC-029 through DEC-032: `next build`+`start` over `next
dev` for CI; bypassing `pw:run` for CI sharding via the new read-only script; ephemeral per-run CI
secrets requiring zero GitHub repository secrets; disclosed, human-confirmable artifact-retention
defaults). Verified the "clean checkout" acceptance criterion live via a from-scratch archive-based
simulation (BLK-001 blocks a real `git clone`): fresh `pnpm install`, typecheck, metadata validation,
lint, `pw:list` (`Total: 385 tests in 37 files`), and a real E2E test against the live app all
succeeded from the fresh copy (one disclosed, harmless nuance: no `.git` directory in an archive
copy triggers normalizedReporter's already-existing git-info fallback, which a real clone would
never hit). Ran the complete validation suite: `pnpm exec tsc --noEmit` clean, `pnpm pw:validate`
clean (`Total: 385 tests in 37 files`), `pnpm pw:test` — **385/385 passed**. Bumped
`FRAMEWORK_VERSION` to `"0.10.0"`. All three workflow YAML files syntax-validated (`python3 -c
"yaml.safe_load(...)"`) and schema-validated (`npx @action-validator/cli`), both clean — disclosed
limitation: none of the three workflows has been executed on a real GitHub Actions runner, since
BLK-001 blocks pushing to the remote where Actions would run; every command inside them was instead
verified directly in this sandbox in the exact sequence/form the workflow specifies  
**Last verified task:** Independent Stage 10 audit (fresh context, no memory of the implementation)
completed and PASSED WITH FINDINGS, then independently re-verified by the orchestrating session
itself (not merely trusted) before this ledger update. The audit re-derived the baseline itself
(`Total: 385 tests in 37 files`, matching the implementer's claim exactly) before touching anything,
rebuilt the clean-checkout simulation from scratch, and adversarially reproduced every reachable CI
scenario (clean pass, consistent failure, flaky/retry-pass via real `--retries=1`, empty-shard
zero-test run, 2-shard split+merge) plus a literal first-time-manual-tester documentation walkthrough
(authored a genuinely new reference-style test using only `PLAYWRIGHT_TESTING.md`'s tutorial text,
which passed on the first real attempt). No High-or-above finding. Three Medium findings, one fixed
live (see the Stage 10 audit gate above for full detail): the tagging cheat sheet's `special-purpose`
→ `test-type` mismatch was corrected in both `PLAYWRIGHT_TESTING.md` and the manual-test-to-automation
worksheet; two documentation/design-narrative inaccuracies (the zero-`--grep` exit-code claim, and
`weekly-quality-review.yml`'s `--repeat-each`/`--retries=0` flaky-detection claim) were disclosed and
left open since the underlying CI safety property holds regardless. **The orchestrating session
independently re-verified this rather than trusting the audit's report, and in doing so found and
corrected a further inaccuracy inside the audit's own write-up**: confirmed the `test-type` fix is
real in both files against the actual `quality/tag-taxonomy.yaml`; independently re-ran
`pnpm exec tsc --noEmit` and `pnpm pw:validate` (`Total: 385 tests in 37 files`) directly, not reused
from the audit; independently reproduced the `weekly-quality-review.yml` flaky-claim finding with a
real scratch test failing on exactly one of three `--repeat-each` iterations under real `--retries=0`
(confirmed `retryPass: 0`, a hard `::error::`, exactly as the audit described); and, while
re-verifying the zero-`--grep` finding specifically rather than accepting it at face value,
discovered that the audit's own claim that this scenario "writes no run report at all" is itself
inaccurate — a real all-zero-counts report is written every time (reproduced three separate times,
including with the audit's exact pattern string, each via an isolated before/after directory listing),
and `ci-summary.ts` correctly classifies it as a zero-test run through its ordinary report-reading
path, not the "no reports found" fail-closed branch the audit credited. Corrected in place inside
`quality/audits/stage-10-audit.md` (Section 2 and Finding 1) with no change to the bottom-line
verdict, and clearly marked as an orchestrator correction rather than silently rewritten. `git
status --short` confirmed clean of scratch artifacts both after the audit and after this session's
own independent re-verification and cleanup. See `quality/audits/stage-10-audit.md` for full detail  
**Last passing audit:** `quality/audits/stage-10-audit.md` — PASS WITH FINDINGS (independently
re-verified by the orchestrating session, including one correction made to the audit document itself)  
**Active blockers:** BLK-001 (GitHub session-repo-authorization gate) still blocks `git push`/PR
creation for Stages 02–10 alike — implementation and audit work continue regardless per standing
instruction  
**Next action:** Commit Stage 10 as a new commit; once BLK-001 clears, commit/push and open PRs for
Stages 02–10; then begin Stage 11 — Final system audit and handoff

### Progress dashboard

- [x] Stage 00 — Repository discovery and implementation plan
- [x] Stage 01 — Playwright foundation and environment safety
- [x] Stage 02 — Test governance, metadata, tags, and value model
- [x] Stage 03 — Page objects, fixtures, test data, and evidence architecture
- [x] Stage 04 — Test-authoring standards, enforcement, and reference tests
- [x] Stage 05 — Tag-expression runner and safe execution workflow
- [x] Stage 06 — Test-run reporting and diagnostic artifacts
- [x] Stage 07 — Suite review, coverage analysis, and test catalog
- [x] Stage 08 — Claude Code skills, commands, subagents, and hooks
- [x] Stage 09 — Failure triage and controlled test repair
- [x] Stage 10 — CI, documentation, adoption, and operational hardening
- [ ] Stage 11 — Final system audit and handoff

### Decision log

| ID | Date | Decision | Reason | Human approval required? |
|---|---|---|---|---|
| DEC-001 | TBD | Use TypeScript unless the repository requires another supported Playwright language | Best support for Playwright Test and typed framework utilities | No |
| DEC-002 | 2026-09-10 | No repo-committed Node version file exists; framework tooling will target the version actually in use (Node 22.x) rather than inventing an `.nvmrc` unasked | Avoid imposing a new project-wide convention during a testing-framework build; the repo owner didn't request one | No — flagged for awareness only |
| DEC-003 | 2026-09-10 | Chromium-only browser project for now; Firefox/WebKit stay defined but unused in `playwright.config.ts` | App has no deployed users yet and no known cross-browser defect history to justify the extra CI time | No — reversible later by enabling the existing project entries |
| DEC-004 | 2026-09-10 | Editor deep-links in reports default to off (plain relative file links only) until the human states a preferred editor | Spec Section 5 lists this as a profile item with no discovered value; safest default is "do nothing extra" rather than guess an editor scheme | No — cosmetic, easy to add later |
| DEC-005 | 2026-09-10 | Production is treated as **undefined** everywhere the framework needs a production hostname (Stage 01's fail-closed guard, Stage 05's production preflight) | The app has never been deployed; there is no real host to allow-list, so every environment must be treated as non-production and mutating tests must never be approved for it by default | Yes — human must explicitly configure and approve a real production hostname before any mutating-test production policy can change |
| DEC-006 | 2026-09-10 | `playwright.config.ts` reads an optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env var and, only when set, passes it as `launchOptions.executablePath` for the chromium project | The cloud sandbox pre-installs a Chromium build whose revision doesn't always match what a given `@playwright/test` version expects, with no network access to fetch a replacement; this variable is unset (and a no-op) anywhere `pnpm pw:install` / `playwright install` has been run normally, e.g. a developer's machine or CI | No — additive, defaults to Playwright's normal behavior |
| DEC-007 | 2026-09-10 | `e2e/support/globalSetup.ts` derives "does this selection include a mutating test" from a temporary env var (`PW_SIMULATE_MUTATING_SELECTION`) rather than a real computed selection | Stage 05 (the tag-expression runner) is what will actually know which tests are selected; until then this is the only way to prove the production/mutation guard blocks a run *before browser launch*, end-to-end through Playwright itself, rather than only via unit tests | No now — **Stage 05 must replace this simulation with the runner's real selection result; tracked as a required follow-up in Stage 05's own audit, not optional polish** |
| DEC-008 | 2026-09-10 | The "versioned schemas" Stage 02 calls for are zod schemas (`playwright-framework/metadata/schemas.ts`), not a separate hand-maintained JSON Schema file | The repo's existing convention (Stage 01's `e2e/support/env.ts`) already validates config with zod; a second, parallel schema format would only be a second place to drift out of sync. Each schema file's own `schemaVersion` literal is the version marker | No — reversible; a JSON Schema export could be generated from these zod schemas later if an external tool ever needs one |
| DEC-009 | 2026-09-10 | `quality/requirements.yaml` is seeded with ~18 real feature-area entries copied verbatim (title + TS/FR ticket refs) from README.md's "What's implemented" section, every one at `status: needs-human-review`, plus two explicitly fake `status: placeholder` examples | Spec Section 5's Project Profile is explicit that this file "will start from that list ... explicitly not invented wholesale by the agent." Seeding from a real, existing document (not inventing business requirements) satisfies that while leaving every entry awaiting human confirmation before any test may cite it as authoritative | Yes — a human must review/confirm/correct/reprioritize each `needs-human-review` entry before it should be treated as an authoritative acceptance requirement |
| DEC-010 | 2026-09-10 | Both the value rubric (Section 8.3) and the quality rubric (Section 8.5) live in one file, `quality/test-value-model.yaml`, rather than a separate quality-model file | Stage 02's own task list and file inventory name only `test-value-model.yaml`/`.md` and `value-overrides.yaml` — no second model file is called for anywhere in the spec, and the two rubrics share a schema version/change-history/model-version concept, so splitting them would duplicate that plumbing for no asked-for benefit | No — reversible; nothing outside this file assumes the two rubrics are combined |
| DEC-011 | 2026-09-10 | Per-test governed metadata (id, objective, expectedOutcome, requirementIds, tags) is attached via a thin wrapper (`defineQualityTest`) around Playwright's own native `test(title, { tag, annotation }, body)` form, validated against the tag taxonomy at collection time | Playwright 1.63 already supports native `tag`/`annotation` on `test()`; building a parallel test-registration system instead would break `--grep`, HTML-report tag filtering, the VS Code extension, and `test.step` for no gain. The taxonomy-aware AND/OR/NOT/parenthesized query language Section 9.2 asks for is a CLI-level concern layered on these same native tags — that's a later stage's runner, not this stage's authoring helper | No — additive; every other Playwright feature keeps working unmodified |
| DEC-012 | 2026-09-10 | `WeddingDataSetup.deleteUserAccount()` (Stage 03's test-data cleanup interface) is an explicit, always-throwing `UnsupportedCleanupError` rather than a real cleanup implementation or a silent no-op | The application exposes no account-deletion endpoint of any kind — discovered while implementing Stage 03's data setup/cleanup interfaces, not assumed in advance. Every account this framework's `account`/`signUpFreshAccount` fixture creates is therefore permanent test data in whatever database the suite runs against (the dev database already carries 1878 pre-existing users, consistent with this having been true throughout the app's life). An explicit throw makes this limitation loud and discoverable at the call site rather than a cleanup step that silently does nothing | Yes — a human should decide whether this warrants adding a real account-deletion endpoint to the application (out of scope for this testing-framework build), routing suite runs at an isolated/disposable database instead, or accepting indefinite test-account accumulation as a known cost |
| DEC-013 | 2026-09-10 | Stage 04's "lint/static rules for raw selectors outside approved abstractions" (and the other authoring-standard checks) are a small hand-written TypeScript-compiler-API AST checker (`playwright-framework/validation/lintRules.ts`), run via a CLI script (`pw:lint-tests`), rather than an ESLint plugin/config | This repo has no root-level ESLint of its own — only `apps/web` does, scoped to the Next.js app and outside this project's own `tsconfig.json` include list — so adopting ESLint here would mean standing up a second, differently-shaped tool with its own config format and plugin API just for this. A hand-written AST walk keeps the same "plain, unit-tested TypeScript module" shape every other framework validator already uses (`tagValidation.ts`, `validateMetadata.ts`), and it is what actually closed a real, previously-undiscovered gap: nothing before this stage ever ran Stage 02's `validateAllTestMetadata` against the REAL test suite (only against synthetic data in its own unit test) — `playwright-framework/validation/discoverTestMetadata.ts` statically discovers real `defineQualityTest(...)` metadata literals via the same AST approach and feeds them into that existing validator | No — reversible; an ESLint-based rewrite could replace this later without changing the rules' meaning, and nothing outside `pw:lint-tests` depends on the implementation being AST-based rather than ESLint-based |
| DEC-014 | 2026-09-10 | The Stage 04 exception mechanism ("documented exception mechanism requiring rationale and review") is a single-line source comment, `// pw-lint-exception: <rule> -- <rationale>`, on the flagged line or the one line immediately before it — not a config-file allowlist or a structured annotation | Keeping the exception physically next to the code it excuses (rather than in a separate allowlist file) means a reviewer sees the rationale in the same diff as the violation, and it can never silently apply to a line it wasn't written for. The one real, deliberate exception in this repo (`e2e/tests/framework-health.spec.ts`'s raw selector against its own inline HTML — spec Section 7.2's own "except framework self-tests" carve-out) uses it. Constraint, disclosed in `PLAYWRIGHT_TESTING.md`: the rationale must stay on one line, since the checker only looks one line back — a wrapped, multi-line rationale comment will not be seen | No — reversible; the one-line constraint is a real, documented usability limitation, not a design goal, and could be lifted later by scanning further back for a contiguous comment block |
| DEC-015 | 2026-09-10 | `compileToGrepPattern` (Stage 05's tag-expression → `--grep` regex compiler) anchors the ENTIRE compiled expression to the start of the title with a leading `^`, not just each node compiling to a zero-width assertion as originally designed | Found by this module's own `compileToGrepPattern`-vs-`evaluateExpression` cross-verification unit test — the one built specifically to satisfy the Stage 05 audit gate's "compare runner selection with direct Playwright discovery across a representative query matrix" — BEFORE any audit ran, not by an auditor: `--grep` (and this module's own cross-check, using plain unanchored `RegExp.test`) searches for a match starting at ANY position in the title, not just position 0. Every node is zero-width by design, which is harmless for a pattern that's satisfied at position 0 — but for a `NOT` whose operand is only true "as of position 0" (e.g. "the title contains `@quarantined` somewhere"), retrying the search at a position AFTER that tag's own text has already gone by makes the negated lookahead incorrectly succeed there (nothing named `@quarantined` remains ahead of that later position). `NOT @quarantined` therefore matched every title of nonzero length, including ones that DID carry `@quarantined` — an unconditional false positive for every negated expression, not an edge case. Anchoring the whole compiled formula with `^` forces it to be evaluated exactly once, at one fixed position, which is what "evaluate this boolean expression against the test's tags" means. Re-verified two ways after the fix: the full 40-test unit suite (10 expressions × 6 tag combinations, including the two that had failed) passes, and real `pnpm exec playwright test --grep '<pattern>' --list` invocations against the live suite for both previously-broken cases (`NOT @quarantined`, `NOT (@readonly OR @mutating)`) return exactly the hand-counted complement (37 and 35 out of 37 total, respectively) | No — this is a correctness fix to code that had not yet shipped or been audited; nothing outside `tagExpression.ts`'s own tests depended on the broken unanchored behavior |
| DEC-016 | 2026-09-10 | `RunResultFileSchema` (defined in Stage 02, unused until now) is extended with `compiledGrepPattern` (string), `matchedTestIds` (string array), and `executionConfig` (`{ workers?, repeatEach?, reporter?, allowProductionFlagPassed }`) — all new fields, nothing renamed or removed | Stage 05's own task ("capture the normalized expression and exact execution configuration in the run manifest") needs more than the schema's original `tagExpression: string` field alone provides; extending the existing schema (rather than inventing a second, parallel manifest shape) matches Stage 02's own stated intent that "later stages consume a stable shape rather than inventing one under deadline." `outcomes` is deliberately left `[]` by `pw:run` — populating real per-test pass/fail/attempt results is Stage 06's reporter work (parsing Playwright's own run output), and Stage 05's manifest exists to prove what was asked for and how it was configured, not to report what happened | No — additive and backward compatible; nothing in this codebase constructed a `RunResultFile` before Stage 05, so there is no existing data this could invalidate |
| DEC-017 | 2026-09-10 | `pnpm pw:run` treats `--allow-production` as a flag that must be passed explicitly on the SAME invocation, and never inherits an ambient `PLAYWRIGHT_ALLOW_PRODUCTION=1` left set in the calling shell's environment for its own preflight decision (the spawned child process's own env is always built explicitly from this invocation's own flag, never passed through from `process.env`) | Stage 05's task list asks for "explicit confirmation requirements for allowed production read-only execution" as a requirement distinct from Stage 01's original env-var-only gate. An env var that happens to be set in a long-lived shell session (from an earlier, deliberate run) is not the same thing as a person consciously deciding THIS run should touch production; requiring the flag on every invocation makes "I meant to do this, right now" the actual signal, rather than shell-environment hygiene | No — additive safety requirement, strictly more restrictive than before; a genuinely-intended production read-only run still works, it just needs one extra flag |
| DEC-018 | 2026-09-10 | The production/mutation guard's knowledge of "does this selection include a mutating test" (`e2e/support/globalSetup.ts` reading `PW_RUN_HAS_MUTATING_SELECTION`) is scoped to runs launched through `pnpm pw:run`; a bare `playwright test --grep ...` invoked directly bypasses this computation entirely and the guard defaults to treating it as non-mutating | Playwright's own `globalSetup` hook receives a `FullConfig`, not a resolved, `--grep`-filtered test list — there is no public API for `globalSetup` to independently determine "which tests would this invocation actually run" without either reimplementing Playwright's own test collection or waiting until each test file loads (too late — the guard must block before browser launch). This is disclosed rather than silently accepted: `PLAYWRIGHT_TESTING.md` and `README.md` both now state, in the production-safety section, that tagged application tests must always be run through `pw:run`, never `playwright test` directly, once a real production host is configured | Yes — flagged for the Stage 05 audit's own "test production guards and adversarial tag input" gate to assess whether this scoping is acceptable as shipped, or whether Stage 05 needs a stronger mechanism (e.g., a wrapper script that is the ONLY documented way to invoke Playwright once `PRODUCTION_HOSTNAMES` is non-empty) before this can be considered fully closed |
| DEC-019 | 2026-09-10 | Stage 06's custom reporter (`normalizedReporter.ts`) overrides `filePath`/`line` for any `defineQualityTest`-wrapped test with a value looked up from `discoverAllApplicationTests()`'s own AST-based static discovery (keyed by the test's declared `id`), rather than trusting Playwright's own `TestCase.location` for every test | Self-caught during Stage 06's own manual verification, before any audit ran: a real run of `guest-viewing.spec.ts` produced a report whose `filePath`/`line` pointed at `playwright-framework/metadata/defineQualityTest.ts:87` — the wrapper's own internal `testFn(...)` call site — not the real spec file the test author wrote `defineQualityTest({...}, ...)` in. This is systematic, not a fluke: Playwright resolves a `TestCase`'s location to wherever `test()`/`testFn()` is textually invoked during collection, and for every wrapped test that is always inside the wrapper module itself. A report whose "go look at this source line" link for every governed test points at framework internals instead of the test the author wrote would actively mislead anyone trying to fix a failure. The fix reuses discovery data the reporter was already computing (for `selectionSummary.excludedCount`), so this is a lookup against data already in hand, not a second parse pass. Tests that don't go through the wrapper at all (`framework-health.spec.ts`, `e2e/tests/unit/*.spec.ts`) have no entry in that lookup and keep Playwright's own (already-correct) `test.location` as the fallback — verified live: a mixed run of both kinds of test produced correct `filePath`/`line` for all three | No — this is a correctness fix to code that had not yet shipped or been audited; nothing depended on the wrapper-attributed location being reported |
| DEC-020 | 2026-09-10 | `classifyOutcome` explicitly maps Playwright's fifth `TestResult.status`, `interrupted` (a worker crash, or the whole run cancelled mid-test), to this framework's `setup-failure` category, rather than letting it fall through the existing `if`/`else` chain by elimination | Self-caught while reviewing whether the 8 documented categories (Section 10.2) truly cover every status Playwright can produce: `interrupted` previously reached the final `if (namedSteps.length === 0) return "setup-failure"; return "consistent-failure"` fallback only because nothing earlier in the chain claimed it — correct by accident, not by an explicit decision, and the surrounding comment (`// result.status === "failed" ...`) was actively wrong for this case. An interrupted test never reached its own pass/fail determination at all, which is the same honest characterization already used for `setup-failure` ("not the test's own assertions") — so the outcome is unchanged, but the code and its documentation now say so directly rather than relying on silent fallthrough | No — behavior-preserving; makes an already-correct-by-accident code path explicit and documented |
| DEC-021 | 2026-09-10 | Stage 07's per-test value/quality evaluation (`playwright-framework/evaluation/evaluateTest.ts`) splits the 14 total criteria three ways: 9 computed MECHANICALLY fresh on every `pnpm pw:review` invocation from real tool output (lint findings, shared-fixture usage, run-report history, suite-wide comparison) and never hand-typed; 2 (`assertion-strength-and-objective-traceability`, `security-compliance-data-integrity`) that genuinely require reading a specific test's own assertions, read from a hand-authored `quality/test-evaluations.yaml` entry keyed by `testId` (defaults to `needsHumanReview: true` with no entry); and 4 value criteria (`business-criticality`, `user-impact-and-frequency`, `risk-and-defect-likelihood`, `release-decision-usefulness`) permanently, mechanically forced to `needsHumanReview: true` | Section 8.6 is explicit that "missing business information must be marked NEEDS HUMAN REVIEW; the AI must not invent impact or regulatory importance." `quality/requirements.yaml` has no priority/impact field and every real requirement is still `status: needs-human-review`, not `confirmed` (DEC-009) — there is no real data source yet to honestly ground a business-priority judgment against. This is a direct, disclosed consequence, not a shortfall: every current test's VALUE score is `provisional` today (4 of 6 criteria unresolved) while QUALITY scores are fully calculable once a `quality/test-evaluations.yaml` entry exists — verified live against the real 2-test suite (`pnpm pw:review`; both tests scored 96/97 quality, 22/20 value, both `provisional: true` on the value side only) | Yes — a human confirming real requirement priorities in `quality/requirements.yaml` (or adding a dedicated priority/impact data source) is what will let the 4 forced criteria stop being permanently unresolved; tracked as an open, expected state, not a defect |
| DEC-022 | 2026-09-10 | Risk-weighted coverage (`computeRiskWeightedCoverage`) weights each COVERED requirement by the highest `@risk:*` tier among its covering test(s) (critical=4, high=3, normal=2, low=1); an UNCOVERED requirement is conservatively weighted as `@risk:critical` (4), since its real risk is unconfirmed without a test | A plain covered/total requirement-coverage percentage treats a critical-risk gap and a low-risk gap identically, which understates what actually matters for release confidence (Section 10.3: "risk-weighted coverage" as its own reported number, distinct from plain coverage). Conservatively assuming the worst for an untested requirement, rather than guessing its real risk, guarantees risk-weighted coverage can never read HIGHER than plain coverage — proven directly in `computeCoverage.spec.ts` (`riskPct <= plainPct` assertion against synthetic data) and re-confirmed against the real suite (`pnpm pw:review`: plain coverage 1/18 ≈ 5.6%, risk-weighted 2/70 ≈ 2.9%, strictly lower) | No — reversible; a future stage could add a per-requirement priority field and use it directly instead of inferring risk from covering tests, without changing this module's public shape |
| DEC-023 | 2026-09-10 | A new `playwright-framework/version.ts` constant (`FRAMEWORK_VERSION`) is the single source of truth for the "framework version" Section 10.1 (run reports) and Section 10.3 (suite reviews) both ask reports to disclose, tracking the highest spec stage completed and audited so far, bumped in the same commit that closes a stage's audit | This repo's root `package.json` carries no `version` field of its own, and Stage 06's run report never needed a framework-version concept (only `playwrightVersion`, a different thing); Stage 07's `SuiteReviewSchema` is the first place the spec's own "framework version" language needs a real value to show. A dedicated constant, rather than reusing `playwrightVersion` or inventing a per-file string, keeps this in exactly one place for every future stage's reports to share | No — cosmetic bookkeeping; reversible by wiring it to a real package version later if one is ever added |
| DEC-024 | 2026-09-10 | `repair-write-guard.mjs` (blocks writes outside approved test-framework paths) and `readonly-bash-guard.mjs` (blocks Write/Edit/NotebookEdit and mutating Bash commands) are wired only into individual subagents' own frontmatter `hooks:` field (`.claude/agents/{playwright-repair,playwright-reviewer,playwright-triage}.md`), never into project-wide `.claude/settings.json` | A hook wired project-wide would fire on every `Edit`/`Write`/`Bash` call in every session, including the main session's own ongoing Stage 00-11 build work, which routinely edits `playwright-framework/`, `quality/*.yaml`, and the spec ledger itself -- exactly the paths these two guards must refuse. Scoping via subagent frontmatter (a documented field: "hooks scoped to this subagent") means each guard only ever governs the one subagent it's meant for, with zero risk of it silently blocking unrelated legitimate work elsewhere in the session. The two project-wide hooks (`stage-gate-check.mjs`, `post-edit-validator.mjs`) are deliberately the opposite: they must apply everywhere (any edit could check a stage box; any edit to a governed file needs the lightweight check), so each does its own fast path-check first thing rather than relying on hook-config-level filtering | No — reversible, and the alternative (broadening scope) is strictly worse for this framework's own ongoing use of itself |
| DEC-025 | 2026-09-10 | The "approved test-framework paths unless the human explicitly expands scope" repair guard (Section 11.4, hook requirement #1) is enforced as two independent, stacked conditions rather than one: (1) a committed, human-owned `quality/repair-allowed-dirs.yaml` naming the only directories repair may ever touch (`e2e/tests`, `e2e/pages`, `e2e/components` -- never `playwright-framework/`, `quality/*.yaml`, or application source), which no skill/hook/subagent in this framework ever writes to; and (2) an ephemeral, gitignored, per-session `artifacts/playwright/repair-scope.json` that `/pw-repair-test`'s own preflight writes only after explicitly confirming the exact target file with a human | A hook script can mechanically verify a file path against a directory allowlist; it cannot mechanically verify "a human actually said yes" -- Claude Code has no hook-visible signal for that. Rather than inventing an unverifiable trust boundary (e.g. trusting the assistant to have asked), the real security boundary is condition (1): a committed file the assistant categorically never writes to, so the worst case if a session skips its own documented confirmation step is still "touches an existing file already inside a narrow, pre-approved, human-reviewable set of directories" -- never application source, secrets, CI config, or this framework's own governance/scoring rules. Condition (2) adds accountability and precision (exactly which file, this session) without being asked to carry the whole trust burden alone | Yes, in the sense that widening `quality/repair-allowed-dirs.yaml` is itself the explicit, human-initiated action DEC-025 describes -- expected to happen deliberately, not something this decision "corrects" |
| DEC-026 | 2026-09-10 | `stage-gate-check.mjs` requires that `quality/audits/stage-NN-audit.md` contain a line starting exactly `Result: PASS` before that stage's Progress Dashboard box may be checked -- making this framework's own established audit-file convention (every real audit from Stage 00 through Stage 07 already opens `# Stage NN Audit` / blank / `Result: PASS...`) load-bearing for the first time, rather than merely a stylistic habit | Verified directly against all eight existing audit files before choosing this rule: every one already puts `Result: PASS` (or `PASS WITH FINDINGS`) as the first content line, so no historical file needed changing to satisfy it. A hook that could only fail safe by denying every stage transition (e.g. requiring a human-maintained separate manifest of "which stages passed") would add ceremony this framework doesn't need when the existing convention already encodes the same fact reliably | Yes -- a future stage's audit file must keep this convention (`Result: PASS` as a real, matchable line) or the gate will deny that stage's completion; noted in `PLAYWRIGHT_TESTING.md`'s Stage 08 section so it isn't forgotten by Stage 09 onward |
| DEC-027 | 2026-09-11 | Replaced the stale Stage 02 placeholder schema (`MaintenanceClassificationSchema`/`MaintenanceFindingSchema`/`MaintenanceResultFileSchema`, a 5-category enum guessed before Section 10.4 existed) with a schema matching Section 10.4's real 7 failure categories and 12 required per-failure fields, in `playwright-framework/metadata/schemas.ts` | Confirmed via `grep -rln` before deleting anything that the placeholder was referenced nowhere else in the codebase (never imported by a loader, CLI, or test) -- it was genuinely dead, guessed-in-advance scaffolding, not a shape anything already depended on. Section 10.4's real category list (`probable-application-defect`, `probable-test-defect`, `intended-application-change`, `test-data-problem`, `environment-or-infrastructure-problem`, `intermittent-flaky-behavior`, `insufficient-evidence`) and its 12 required fields (test/run IDs; classification+confidence; expected vs. observed; first failed step/assertion; evidence links; comparison with requirements/code changes; evidence for/against app defect; evidence for/against test defect; recommended next action; whether repair is allowed; exact repairable files; suggested defect description) are what Stage 09 actually needs a maintenance finding to carry, and building that now rather than patching the old 5-category guess avoids permanently baking a wrong shape into every downstream consumer (`classifyFailure.ts`, the CLI, the HTML renderer, the repair-write-guard's own maintenance-report gate) | No -- the placeholder was unused scaffolding, not shipped data; nothing valid existed in the old shape for this replacement to invalidate |
| DEC-028 | 2026-09-11 | Failure classification is split into a mechanical tier and a hand-authored tier, mirroring DEC-021's value/quality-scoring precedent exactly: `classifyFailure.ts`'s mechanical tier resolves ONLY two of the seven Section 10.4 categories on its own -- `environment-or-infrastructure-problem` (from a run-report `status: "setup-failure"` or a known infrastructure-error-text regex) and `intermittent-flaky-behavior` (from cross-run history in `runReportHistory.ts` showing the same test both passing and failing) -- while the other four categories (`probable-application-defect`, `probable-test-defect`, `intended-application-change`, `test-data-problem`) require a matching hand-authored entry in `quality/failure-classifications.yaml` (keyed by `testId`, optionally narrowed further by `errorFingerprint`); any failure the mechanical tier can't resolve and that has no matching hand-authored entry defaults, fail-closed, to `insufficient-evidence` | Section 10.4 demands honest evidence-for/evidence-against reasoning about WHY a failure happened -- whether it's a real product regression versus a bad test versus a deliberate behavior change is a judgment call this framework has no reliable mechanical signal for, exactly the same "must not invent business/semantic judgment it doesn't have grounds for" problem DEC-021 already solved for value scoring. Defaulting an unresolved failure to `insufficient-evidence` (rather than guessing one of the four judgment-requiring categories) is what makes `repairAllowed` mechanically safe by construction -- see the `MaintenanceFindingSchema` `.refine()` and the repair-write-guard's independent re-derivation from the on-disk report, both of which treat `insufficient-evidence` and `probable-application-defect` as never-repairable | Yes -- a human (or a `playwright-triage` subagent recommendation a human reviews) must add or confirm each `quality/failure-classifications.yaml` entry before any of the four hand-authored categories can be reached; `insufficient-evidence` is an expected, honest steady state for a failure nobody has classified yet, not a defect in the classifier |
| DEC-029 | 2026-09-11 | CI's application E2E job (`.github/workflows/ci.yml`) starts the app with `pnpm build && pnpm --filter @seatwise/web start`, not `pnpm dev` | Every prior stage's live verification ran against `next dev` (the only mode this sandboxed session has ever run), so this is a deliberate, disclosed departure for CI specifically: a production build is faster to run repeatedly (no per-request dev-mode compilation), deterministic (no hot-reload/dev-only code paths that could behave differently from what a real deployment runs), and more representative of what this app will actually run as once deployed. No test in this suite depends on a dev-mode-only behavior (hot reload, dev error overlays) -- confirmed by reading both reference tests | No -- reversible; switching CI back to `next dev` is a one-line change to the "Start the application" step if a future dev-mode-only behavior needs testing |
| DEC-030 | 2026-09-11 | CI's sharded application E2E job invokes `playwright test` directly (via a new read-only script, `playwright-framework/cli/print-ci-selection.ts`) rather than through `pnpm pw:run` (Stage 05) | `pw:run`'s own `--reporter` flag forwards a single Playwright-native reporter name that REPLACES the whole configured reporter array (a Stage 06 finding, still true today), and it has no `--shard` support at all -- widening Stage 05's own audited CLI to accommodate CI's sharding/multi-reporter needs was judged a larger, riskier change to already-shipped, already-audited code than a small, new, narrowly-scoped script that reuses the exact same selection primitives (`evaluateExpression`, `compileToGrepPattern`) `pw:run` itself uses, verified live to produce identical matched tests to `pw:run --selection regression --list`. This intentionally bypasses `pw:run`'s own production/mutation preflight -- an accepted extension of DEC-018's already-disclosed "a bare `playwright test --grep` bypasses this guard" boundary, safe here specifically because `PRODUCTION_HOSTNAMES` is always empty (DEC-005) so the guard is a no-op regardless. The default shard count (2) is chosen to prove the real sharding+blob-report-merge mechanism continuously (verified live: two real shards each received exactly one of the 2 real application tests, and `playwright merge-reports` combined both shards' blob reports into one report) even though the current 2-test suite doesn't yet need the parallelism it provides | Yes -- `pw:run` must remain the only way to run a selection against a real, configured production host once one exists; this CI-only bypass must never be adapted for local/manual use against production. Also flagged for a human to reconsider once the suite is large enough that CI's shard count should scale with it |
| DEC-031 | 2026-09-11 | CI's application E2E job generates `JWT_SECRET`/`ENCRYPTION_KEY` fresh per run via `openssl rand -hex 32`, written to `$GITHUB_ENV` and never echoed, rather than reading them from GitHub repository secrets | Both values gate an ephemeral, job-lifetime-only Postgres database and app instance that stop existing the moment the job ends -- there is no real credential here to protect across runs, so a stored, long-lived repository secret would be a broader-than-necessary blast radius for something that needs to exist for minutes and never again. `DATABASE_URL` similarly points at a `postgres:16` service container scoped to the job, not a secret. The baseline CI gate therefore requires zero configured GitHub repository secrets | No -- reversible; if a future CI need requires a real, persistent credential (e.g. a real `RESEND_API_KEY` for an email-delivery test), that specific value should become a real repository secret at that time, not retroactively applied to these ephemeral values |
| DEC-032 | 2026-09-11 | CI artifact retention is set to 14 days for the PR-gate and nightly-regression workflows' reports, and 30 days for the weekly quality-review workflow's suite-review/maintenance artifacts | A default was needed for `actions/upload-artifact`'s required behavior (GitHub's own maximum is 90 days) and no existing convention or human preference is on record for this repository; 14 days covers a typical review/investigation window for a single run, 30 days gives the weekly trend-oriented artifacts more than four data points of history before expiring | Yes -- a human should confirm the actual desired retention window for this repository/organization and adjust the `retention-days` values directly in each workflow file; these are disclosed defaults, not a considered policy |

### Blocker log

| ID | Date | Stage | Blocker | Required decision or action | Status |
|---|---|---|---|---|---|
| BLK-001 | 2026-09-10 | 02, 03 | A session-level GitHub repo-authorization gate (separate from the PAT's own validity, confirmed valid via `GET /user`) blocks both `git push` to github.com and direct `api.github.com` calls for `Hoosiertom50/seatwise`: "not in this session's authorized repository set." No `add_repo`-style tool is available to this agent to self-serve past it | Tom (or whoever administers this session's GitHub access) needs to add the repository to this session's authorized set; a fresh PAT alone does not resolve it, and re-attempting the same push/API call is not expected to help | Open — implementation/audit work for Stages 02 and 03 proceeds regardless; PR creation, merge, local-checkout sync, and Jira transitions for both stages are queued behind this |

### Implementation log

Append one row before ending each implementation session.

| Date/time | Stage | Work completed | Verification evidence | Files changed | Next action |
|---|---|---|---|---|---|
| 2026-09-10 | 00 | Repository discovery completed; Project Profile filled in with no unexplained TBDs; five decisions recorded (DEC-002..005); no framework dependency installed | Discovery claims cross-checked live against the repo (package manager/version, Node version, absence of Playwright/CI/`.claude` assets, ESLint/TypeScript config paths, existing `apps/mobile/__tests__`, absence of any deployment config) by an independent adversarial review pass before the audit was marked PASS | `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Sections 4 and 5), `quality/audits/stage-00-audit.md` (new) | Begin Stage 01 — Playwright foundation and environment safety |
| 2026-09-10 | 01 | Installed `@playwright/test`, `typescript`, `zod`, `@types/node` as root devDependencies; created the full target directory skeleton (`e2e/`, `playwright-framework/`, `artifacts/playwright/`, all `.gitkeep`-tracked); implemented a zod-validated typed environment config, a fail-closed production/mutation guard wired into Playwright's `globalSetup` (blocks before any browser launches), `playwright.config.ts` (chromium as the run-by-default project; firefox/webkit defined but unused per DEC-003; native HTML+list reporter; trace/screenshot-on-failure), a framework health test, and root `tsconfig.json`. Added `pw:*` package scripts and gitignore rules for generated report/test-result output. Documented install/run commands in README. Two decisions recorded (DEC-006, DEC-007) | `pnpm exec tsc --noEmit` clean; `pnpm pw:list` shows exactly the 18 intended tests across 3 files with zero bleed from `apps/mobile/__tests__`; `pnpm pw:test` — 18/18 passed, including one real Chromium `page` launch; the production guard was proven end-to-end through Playwright itself in three live scenarios (mutating+production → blocked before any project ran, exit 1; read-only+production+no approval → blocked; read-only+production+approval → 18/18 passed); `git status` after `git add -A` shows only intended source/config/`.gitkeep` files staged, no generated report/test-result content | `package.json`, `pnpm-lock.yaml`, `.gitignore`, `README.md`, `tsconfig.json` (new), `playwright.config.ts` (new), `e2e/support/{env,productionGuard,globalSetup}.ts` (new), `e2e/tests/framework-health.spec.ts` (new), `playwright-framework/tests/{env,productionGuard}.spec.ts` (new), directory skeleton `.gitkeep`s (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Sections 4), `quality/audits/stage-01-audit.md` (new) | Begin Stage 02 — Test governance, metadata, tags, and value model |
| 2026-09-10 | 02 | Installed `yaml`, `tsx` as root devDependencies. Built versioned zod schemas for requirements/tag-taxonomy/value-model/overrides/test-inventory/run-result/maintenance-result (DEC-008); wrote `quality/requirements.yaml` (18 real entries seeded from README, 2 explicit fake placeholders — DEC-009), `quality/tag-taxonomy.yaml` (7 dimensions per Section 9.1, plus conflicts/aliases), `quality/test-value-model.yaml` (6 value + 8 quality criteria matching Section 8.3/8.5 exactly, weights validated to total 100 by the schema itself — DEC-010), generated `quality/test-value-model.md`, and an empty `quality/value-overrides.yaml`. Implemented deterministic value/quality scoring arithmetic (`playwright-framework/scoring/`) that treats a missing or human-review-flagged criterion as provisional rather than a fabricated zero, a value-band lookup, and a human-override layer that never mutates the calculated result. Implemented tag-taxonomy validation (unknown tags, exactly-one/at-least-one dimension rules, conflicts, aliases) and a cross-cutting metadata validator (unique test IDs, unmapped/unknown requirement references, empty objective/expectedOutcome). Implemented `defineQualityTest`, a thin wrapper around Playwright's native `test(title, {tag, annotation}, body)` that validates metadata at collection time (DEC-011). Added two CLI scripts wired into `package.json` (`pw:validate-metadata`, `pw:generate-value-model-md`) and folded the former into `pw:validate`. Added 53 new unit tests (schemas, tag validation, cross-cutting metadata validation, scoring boundaries/bands/missing-info/model-version-change/overrides, real-file loader round-trips including a malformed-YAML and a bad-weights failure case, markdown drift detection, and `defineQualityTest` against the live taxonomy) | `pnpm exec tsc --noEmit` clean; `pnpm pw:validate-metadata` reports 20 requirements / 7 dimensions (33 tags) / model 1.0.0 (6+8 criteria) / 0 overrides, all valid; `pnpm pw:test` — 71/71 passed (18 carried over from Stage 01 + 53 new), including a live manual check that intentionally desyncing `test-value-model.yaml` from the committed `.md` makes the drift-detection test fail, then passes again once reverted; `git status` shows only new framework/quality files plus `package.json`/`pnpm-lock.yaml` — no application code (`apps/`, `packages/`) touched | `package.json`, `pnpm-lock.yaml`, `quality/{requirements,tag-taxonomy,test-value-model}.yaml` (new), `quality/test-value-model.md` (new, generated), `quality/value-overrides.yaml` (new), `playwright-framework/metadata/{schemas,loaders,tagValidation,validateMetadata,defineQualityTest}.ts` (new), `playwright-framework/scoring/{types,bands,computeScore,valueScore,qualityScore,applyOverride}.ts` (new), `playwright-framework/cli/{validate-metadata,generate-value-model-md,renderValueModelMarkdown}.ts` (new), `playwright-framework/tests/{schemas,tagValidation,validateMetadata,scoring,loaders,valueModelMarkdown,defineQualityTest}.spec.ts` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4) | Independent review of Stage 02, then begin Stage 03 — Page objects, fixtures, test data, and evidence architecture |
| 2026-09-10 | 02 | Post-audit fix: closed the independent review's one Medium finding — `ScoreSource`'s `"provisional"` value was declared but never produced; `computeScore.ts` now sets `source: "provisional"` (not `"calculated"`) whenever any criterion is unjudged/needs-human-review. Added a locking unit test | `pnpm exec tsc --noEmit` clean; `pnpm pw:test` 72/72 passed (71 + 1 new); `pnpm pw:validate-metadata` unchanged | `playwright-framework/scoring/computeScore.ts`, `playwright-framework/tests/scoring.spec.ts`, `quality/audits/stage-02-audit.md` (correction note appended) | Merge Stage 02's PR, sync to local checkout, update Jira, begin Stage 03 |
| 2026-09-10 | 03 | Implemented the full Stage 03 architecture. Page/component objects (`e2e/pages/{BasePage,LoginPage,SignupPage,WeddingGuestsPage}.ts`, `e2e/components/GuestRow.ts`) built against the app's own real selectors — stable `id`s where the app has them, `aria-label` prefix matching where it doesn't — with no global mutable state (constructor-injected `Page`/`Locator` only). Typed fixtures (`e2e/fixtures/index.ts`) composing `account` (fresh sign-up via `APIRequestContext`, no embedded credentials — the server's own httpOnly `Set-Cookie` authenticates `page`) → `weddingData` → `managedWedding` (create/cleanup, cleanup failures attached as a warning rather than thrown, so they never mask the test's own result), plus per-test `evidence` and an auto-fixture `diagnostics` (console/failed-request capture, attached only on an unexpected test outcome). Generalized `defineQualityTest` into `createDefineQualityTest<TestArgs, WorkerArgs>(testFn)` (`playwright-framework/metadata/defineQualityTest.ts`) so Stage 02's governed-metadata validation binds to either plain Playwright `test` or this stage's fixture-extended one — closing Stage 02 audit's disclosed "never used by a real test" Low finding. Worker-safe unique test-data naming (`e2e/data/ids.ts`): a bijective base-26 letters-only encoding for guest names (the app's `PERSON_NAME_PATTERN` forbids digits — a real constraint discovered live, not assumed) and a digit-embedding scheme for wedding titles (`WEDDING_NAME_PATTERN` allows them). Pattern-based, configurable redaction (`e2e/support/redaction.ts`) for authorization/bearer/JWT/cookie headers and sensitive JSON/query fields. Collision-safe artifact paths (`e2e/support/artifactPaths.ts`) built on Playwright's own `TestInfo.outputPath()` guarantee rather than a reinvented one. Wrote the first real reference test (`e2e/tests/guest-management.spec.ts`) exercising the entire stack against the live, running app. Documented the discovered absence of any account-deletion endpoint as DEC-012 (`WeddingDataSetup.deleteUserAccount()` throws `UnsupportedCleanupError` rather than silently no-op'ing) | Ran the real dev environment (Postgres + `next dev`, not mocked) and the reference test caught two genuine bugs live: (1) initial test data embedded digits in a guest surname, violating `PERSON_NAME_PATTERN`, a live 422 confirmed via a captured console-message attachment — fixed by switching to `uniquePersonName()`; (2) `GuestRow` lookup used `{ hasText: fullName }`, which silently matches nothing once a guest's name renders as an editable `<input defaultValue>` rather than text (an input's value is never part of `textContent`) — fixed by filtering on `{ has: <input[aria-label=...]> }` and reading `.inputValue()` directly. `pnpm exec tsc --noEmit` clean throughout. `pnpm exec playwright test e2e/tests/guest-management.spec.ts` passes against the live app. Added 32 new unit tests for the pure-logic modules (`e2e/tests/unit/{ids,redaction,artifactPaths}.spec.ts`) — one of which caught a third real bug pre-audit: the `authorization-header` redaction rule used `\S+` and only stripped the scheme word (e.g. "Basic"), leaving Basic-auth credentials themselves sitting in "redacted" evidence text; fixed to consume the rest of the line. `pnpm pw:test` — 105/105 passed (72 carried over + 1 chromium reference test + 32 new unit tests). Ran the reference test 4× concurrently across 4 workers (`--repeat-each=4 --workers=4`) with zero failures or data collisions, confirming worker-safe fixtures/test-data end to end; retry-path artifact-path collision safety is Playwright's own `outputPath()` guarantee (not reinvented here) and so wasn't separately re-verified by hand | `e2e/pages/{BasePage,LoginPage,SignupPage,WeddingGuestsPage}.ts` (new), `e2e/components/GuestRow.ts` (new), `e2e/fixtures/index.ts` (new), `e2e/data/{ids,api}.ts` (new), `e2e/support/{auth,redaction,artifactPaths,evidence}.ts` (new), `e2e/tests/guest-management.spec.ts` (new), `e2e/tests/unit/{ids,redaction,artifactPaths}.spec.ts` (new), `playwright-framework/metadata/defineQualityTest.ts` (generalized to `createDefineQualityTest`), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: DEC-012, BLK-001, Stage 03 task checkboxes, this row) | Dispatch an independent fresh-context audit subagent for Stage 03; on PASS, write `quality/audits/stage-03-audit.md`, check the Stage 03 Progress Dashboard box, commit, and (once BLK-001 clears) open PRs for Stages 02 and 03 |
| 2026-09-10 | 03 | Independent audit (fresh context, no memory of the implementation) completed and PASSED with findings. The audit read every Stage 03 file against the real app source (`GuestsTab.tsx`, wedding/login/signup pages) confirming no fabricated selectors, cross-checked `PERSON_NAME_PATTERN`/`WEDDING_NAME_PATTERN` byte-for-byte against `packages/shared/src/validation.ts`, independently re-ran `tsc --noEmit`, the full suite, the live reference test, and a fresh `--repeat-each=3 --workers=3` parallel run rather than trusting prior results. Its own adversarial redaction probing (values outside the shipped test file) found and fixed one further real High-severity leak during the audit itself: `cookie-header`'s rule had the exact same `\S+`-stops-at-first-token bug already found in `authorization-header`, silently leaving every cookie after the first in a multi-cookie `Cookie` header in cleartext — fixed to consume the rest of the line, with a locking unit test added. Two Medium findings were logged and deliberately left open (an escaped-quote gap in `sensitive-json-field`, inert until a future stage attaches raw JSON bodies as evidence; the disclosed CSS-class login/signup error-selector fallback) and two Low findings (a theoretical, practically-unreachable `ids.ts` seed-collision edge case; DEC-012 carried forward, not re-litigated) | `pnpm exec tsc --noEmit` clean; `pnpm pw:test` — 106/106 passed (105 + 1 new locking test for the cookie-header fix); `git status --short` confirms no application code (`apps/`, `packages/`) was touched and the audit's own throwaway probe script was deleted after use | `e2e/support/redaction.ts` (cookie-header pattern fix), `e2e/tests/unit/redaction.spec.ts` (new locking test), `quality/audits/stage-03-audit.md` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: Stage 03 audit gate checkboxes, Progress Dashboard, this row) | Commit Stage 03; begin Stage 04 — Test-authoring standards, enforcement, and reference tests (PR/merge for Stages 02 and 03 remain queued behind BLK-001) |
| 2026-09-10 | 04 | Wrote `PLAYWRIGHT_TESTING.md` (naming/directory conventions, AAA/`test.step` structure, page/component-object rules, evidence, enforcement, exception mechanism, "walking through a reference test" and "verifying independence" sections). Built a hand-written AST-based static checker (`playwright-framework/validation/lintRules.ts`, DEC-013) enforcing: no raw selector/screenshot calls on `page`/`context`/`frame` in a test file, no fixed waits, no `test.only`, no unreasoned `test.skip`/`.fixme`/`.fail`, no swallowed `catch` blocks, and every test has at least one `expect(...)` call — with a single-line `// pw-lint-exception: <rule> -- <rationale>` comment mechanism (DEC-014) whose one real, documented use so far is `framework-health.spec.ts`'s own inline-HTML selector (spec Section 7.2's explicit framework-self-test carve-out). Built `discoverTestMetadata.ts`, which statically discovers every real `defineQualityTest(...)` metadata literal via the same AST approach — closing a real gap discovered while implementing this stage: Stage 02's `validateAllTestMetadata` had existed since Stage 02 but had NEVER been run against the actual test suite, only against synthetic data in its own unit test. Extended `validateAllTestMetadata` with a "stale metadata" check (a `requirementIds` entry pointing at a requirement whose own `status` is `retired`). Wired all of it into a new `pnpm pw:lint-tests` CLI (folded into `pnpm pw:validate`), plus a naming-convention check (a test's ID must be prefixed with its file's slug). Wrote `e2e/tests/guest-viewing.spec.ts`, the framework's read-only reference test (arranges a guest via the real API, then only navigates and reads — never calls a mutating endpoint or UI control itself). Restructured both reference tests with named Arrange/Act/Assert `test.step`s. Added `playwright-framework/tests/fixtures/badPatternSnippets.ts` (intentionally bad patterns as plain string constants, never real spec files) plus `lintRules.spec.ts`/`discoverTestMetadata.spec.ts` unit tests exercising every rule against those fixtures AND asserting zero false positives against the real reference tests | `pnpm exec tsc --noEmit` clean throughout. `pnpm pw:lint-tests` initially caught a REAL pre-existing violation in `framework-health.spec.ts` (a raw `page.locator()` against its own inline HTML) — resolved with a documented exception comment, the legitimate case Section 7.2 itself carves out, rather than by weakening the rule. `pnpm pw:test` — 127/127 passed (106 carried over + 6 new `discoverTestMetadata` tests + 12 new `lintRules` tests + 1 new stale-metadata unit test + 1 new live `guest-viewing` reference test + 1 new "zero false positives against real reference tests" assertion pulled into the 12). Both reference tests verified live against the running app: individually, together in both orders (Playwright 1.63 has no reverse-order flag, so "order independence" was verified via separate process invocations in swapped order — both pass), with `--repeat-each=3`, and with `--repeat-each=2 --workers=4` — all green, zero data collisions | `PLAYWRIGHT_TESTING.md` (new), `playwright-framework/validation/{lintRules,discoverTestMetadata}.ts` (new), `playwright-framework/cli/lint-tests.ts` (new), `playwright-framework/metadata/validateMetadata.ts` (stale-requirement check added), `playwright-framework/tests/{lintRules,discoverTestMetadata}.spec.ts` (new), `playwright-framework/tests/fixtures/badPatternSnippets.ts` (new), `playwright-framework/tests/validateMetadata.spec.ts` (new test case), `e2e/tests/guest-viewing.spec.ts` (new), `e2e/tests/guest-management.spec.ts` (restructured with `test.step`), `e2e/tests/framework-health.spec.ts` (documented lint exception), `package.json` (`pw:lint-tests` script, folded into `pw:validate`), `README.md` (Playwright section updated for Stage 04), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: DEC-013, DEC-014, Stage 04 task checkboxes, this row) | Dispatch an independent fresh-context audit subagent for Stage 04; on PASS, write `quality/audits/stage-04-audit.md`, check the Stage 04 Progress Dashboard box, commit, and (once BLK-001 clears) open PRs for Stages 02–04 |
| 2026-09-10 | 04 | Independent audit (fresh context, no memory of the implementation) completed and PASSED with findings. The audit cold-read both reference tests before opening any page object (per the audit gate's own instruction) and confirmed the cold reading matched the real implementation exactly. It independently re-ran `tsc --noEmit`, `pnpm pw:lint-tests` (output matched the log's claim exactly: 1 exception noted, 3 test files, 2 discovered tests, 0 hard failures), the full suite, both reference tests together/individually/in swapped process order/under `--repeat-each`/`--workers`, and deliberately broke a temporary scratch file inside `e2e/tests/` twice (a `test.only` + raw selector; a mismatched test-id prefix) to confirm `pw:lint-tests` genuinely catches real violations and exits non-zero, deleting the scratch files immediately after. Its own adversarial lint probing (snippets outside `badPatternSnippets.ts`) found and fixed one real High-severity gap live: `lintRules.ts`'s `raw-selector-in-test`/`raw-screenshot-in-test`/`fixed-wait` rules matched only the literal identifiers `page`/`context`/`frame`, silently bypassed by an ordinary destructure-rename (`{ page: p }`) or local alias (`const thePage = page`) — not an exotic evasion, the single most common way a multi-page test renames its `page` fixture. Fixed with a `collectReceiverAliases` fixed-point pre-pass resolving destructure-renamed parameters and direct local aliases, plus two new locking tests. Also confirmed the stale-metadata check is structurally correct and mutually exclusive from "unknown requirement" (its own unit test asserts both). Two Medium findings (a `swallowed-error` false positive on a catch that delegates to an always-throwing helper; a false negative when a catch calls a locally-shadowed function literally named `attach`/`expect`) and three Low findings (a `missing-assertion` scoping gap for `test.only`/`.skip`/`.fixme`/`.fail`; `test.step` callbacks with zero assertions not separately flagged when the outer test has some, which matches the spec's literal per-test wording; the one documented lint exception confirmed genuine) were logged and deliberately left open | `pnpm exec tsc --noEmit` clean; `pnpm pw:lint-tests` — `Lint OK: 3 test file(s), 2 discovered test(s), 0 hard failures` unchanged after the fix (zero false positives introduced against the real suite); `pnpm pw:test` — **129/129 passed** (127 pre-fix + 2 new locking tests for the receiver-alias fix); both reference tests re-verified live against the running app individually, together, under `--repeat-each=2 --workers=3`, and as separate process invocations in swapped order — all green; the audit's own scratch/probe files were deleted after use (`ls e2e/tests/` confirms only the three real spec files plus `unit/` remain) | `playwright-framework/validation/lintRules.ts` (`collectReceiverAliases` added; the three receiver checks now consult it instead of the fixed three-name set), `playwright-framework/tests/fixtures/badPatternSnippets.ts` (two new alias-bypass fixtures), `playwright-framework/tests/lintRules.spec.ts` (two new locking tests), `quality/audits/stage-04-audit.md` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: Stage 04 audit gate checkboxes, Progress Dashboard, this row) | Commit Stage 04 (blocked on BLK-001 for push/PR only); begin Stage 05 — Tag-expression runner and safe execution workflow, including DEC-007's tracked follow-up (replace `PW_SIMULATE_MUTATING_SELECTION` with the runner's real selection result) |
| 2026-09-10 | 05 | Implemented the full Stage 05 tag-expression runner. `playwright-framework/runner/tagExpression.ts`: a recursive-descent parser (tokenizer + parser) for `@tag`/AND/OR/NOT (word and symbolic forms)/parentheses, rejecting every malformed/injection-shaped input as a `TagExpressionSyntaxError` naming the offending text and position; `evaluateExpression` (alias-resolving boolean evaluation against a test's own tags); `compileToGrepPattern` (compiles to a single JS-regex string Playwright's own `--grep` already understands — every node compiles to a self-contained zero-width assertion, so AND/OR/NOT compose correctly to arbitrary nesting depth); `findContradictions` (an AND of two mutually-exclusive tags — an explicit taxonomy conflict or two tags from the same `exactly-one` dimension — is flagged before ever discovering or running anything). Added `quality/saved-selections.yaml` (`readonly`/`smoke`/`regression`/`critical`) with a matching zod schema/loader following the established `quality/*.yaml` pattern. Built `playwright-framework/cli/run-tests.ts` (`pnpm pw:run`): resolves a raw expression or `--selection <name>`, validates every referenced tag against the live taxonomy, runs `findContradictions`, statically discovers the real tagged suite (the same discovery `pw:lint-tests` uses) and evaluates the expression against it, refuses a zero-match selection outright, runs the environment/production preflight (a mutating selection is refused unconditionally against a configured production host; a read-only one additionally requires this specific invocation to pass `--allow-production`, never an inherited ambient env var — DEC-017), and — unless `--list`/`--preview` — spawns the real `playwright test` CLI via `execFileSync` with an argv array (never a shell string) forwarding only `--workers`/`--repeat-each`/`--reporter`, then writes a schema-validated run manifest (`RunResultFileSchema`, extended per DEC-016). Argv parsing was split into its own pure module (`playwright-framework/runner/parseRunArgs.ts`) specifically so it could be unit-tested directly rather than only through the CLI's process exit codes. Replaced Stage 01/04's temporary `PW_SIMULATE_MUTATING_SELECTION` simulation in `e2e/support/globalSetup.ts` with the runner's own real, computed `PW_RUN_HAS_MUTATING_SELECTION` (DEC-007's tracked follow-up, now closed) — documented the resulting coverage scope as DEC-018 (a bare `playwright test --grep` bypassing `pw:run` is not covered; flagged for the audit to assess). Added package scripts `pw:run`, `pw:run:readonly`, `pw:run:smoke`, `pw:run:regression`, `pw:run:critical`. Wrote a new `PLAYWRIGHT_TESTING.md` section ("Running tests by tag") and updated `README.md`'s Playwright section for Stage 05 | Wrote `playwright-framework/tests/tagExpression.spec.ts` FIRST, as the automated form of the audit gate's own "compare runner selection with direct Playwright discovery across a representative query matrix" instruction (10 expressions × 6 tag combinations, cross-checking `compileToGrepPattern` against `evaluateExpression`) — and it caught a real bug before any audit did: `NOT @quarantined` and two other NOT-containing expressions failed the cross-check (DEC-015 — unanchored-regex `NOT` was a universal false positive, not an edge case). Fixed by anchoring the whole compiled expression with `^`; re-ran the full 40-test suite (all pass) AND re-verified against the real CLI (`pnpm exec playwright test --grep '<pattern>' --list`) for both previously-broken cases, matching hand-counted complements exactly (37/37 and 35/37). `pnpm exec tsc --noEmit` clean throughout. `pnpm pw:test` — **189/189 passed** (169 carried over + 20 new `parseRunArgs` unit tests; the 40 `tagExpression` tests were already counted in the 169 since that spec file existed before this session's verification pass began). Manually exercised `pw:run` end-to-end against the live running app (not mocked): preview and actual execution agreed exactly (2/2 matching test IDs for `@readonly OR @mutating`); unknown tag, contradictory expression (`@readonly AND @mutating`), shell-injection-shaped input (`@readonly; rm -rf /`), and a zero-match selection were all rejected with friendly messages and non-zero exit, and never reached Playwright; `--workers`/`--repeat-each`/`--reporter` forwarding worked (verified a real `--repeat-each 2` run); an unrecognized flag and a malicious `--reporter` value were both rejected; a real run manifest was written and validated (`RunResultFileSchema.parse` succeeds) with the correct git commit hash, matched test IDs, and compiled grep pattern; the production/mutation guard was exercised against a temporary simulated production host for all four combinations (mutating always refused even WITH `--allow-production`; read-only refused without it; read-only allowed with it; preview surfaces the same verdict — added after manual testing surfaced that preview originally said nothing about production status, which the audit gate's own "test production guards" instruction would very likely have flagged) | `playwright-framework/runner/{tagExpression,parseRunArgs}.ts` (new), `playwright-framework/tests/{tagExpression,parseRunArgs}.spec.ts` (new), `playwright-framework/cli/run-tests.ts` (new), `playwright-framework/metadata/schemas.ts` (`SavedSelectionSchema`/`SavedSelectionsFileSchema` added; `RunResultFileSchema` extended per DEC-016), `playwright-framework/metadata/loaders.ts` (`loadSavedSelections` added), `quality/saved-selections.yaml` (new), `e2e/support/globalSetup.ts` (real selection signal replaces DEC-007's simulation), `package.json` (`pw:run*` scripts), `PLAYWRIGHT_TESTING.md` ("Running tests by tag" section), `README.md` (Playwright section updated for Stage 05), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: DEC-015 through DEC-018, Stage 05 task checkboxes, this row) | Dispatch an independent fresh-context audit subagent for Stage 05; on PASS, write `quality/audits/stage-05-audit.md`, check the Stage 05 Progress Dashboard box, commit, and (once BLK-001 clears) open PRs for Stages 02–05 |
| 2026-09-10 | 05 | Independent audit (fresh context, no memory of the implementation) completed and PASSED WITH FINDINGS. The audit built its own query matrix independent of the shipped `tagExpression.spec.ts` unit tests (bare tags, ORs, a tautology, a satisfiable-but-empty case, a logical contradiction, synthetic prefix-colliding tags) and ran each three ways — `pw:run --list`, a direct `--grep --list` using the pattern obtained by actually calling `compileToGrepPattern` (never hand-derived), and a scratch-script cross-check against `evaluateExpression` — which is what surfaced both findings below, neither present in the pre-existing unit suite. **Finding 1 (High, fixed):** `compileToGrepPattern` had no tag-boundary anchoring, so a tag that is a literal prefix of another tag's name (reproduced with synthetic `@a`/`@ab`) could spuriously match or be spuriously excluded by `NOT` — dormant against the real 33-tag taxonomy today (checked exhaustively, pairwise) but a real latent bug, and plausible to hit given the taxonomy's own colon-namespaced tag style. Fixed with a trailing `(?![A-Za-z0-9:_-])` boundary assertion on every compiled tag literal; new locking test in `tagExpression.spec.ts`. **Finding 2 (High, fixed):** the real spawned `playwright test` invocation could select MORE tests than preview showed — a genuine violation of the stage's own acceptance criterion "preview and actual execution select the same tests" — because `--grep` matches against every test's full title project-wide, including untagged framework/unit tests (`framework-health.spec.ts`, `e2e/tests/unit/**`) that preview's own `discoverAllTests()`/`evaluateExpression` never consider (they carry no `defineQualityTest` metadata at all). Verified live and not hypothetical: `pnpm pw:run "NOT @quarantined" --list` reported 2 matched tests; the equivalent direct `--grep` invocation, before the fix, matched 37 across 5 files — meaning a real (non-preview) run of that same command would silently have executed 35 tests preview never mentioned. Fixed by also passing the matched tests' own spec files as positional arguments to the spawned invocation, so Playwright can only ever discover tests inside those files in the first place (`--grep` still narrows within them exactly as before) — extracted into a new pure module, `playwright-framework/runner/buildPlaywrightInvocation.ts` (mirroring `parseRunArgs.ts`'s precedent for testing CLI internals without executing `main()`), with 4 new locking tests in `playwright-framework/tests/buildPlaywrightInvocation.spec.ts`. Re-verified live after both fixes: every row of the audit's query matrix agrees exactly across all three methods, and a real (non-preview) execution of `pw:run "NOT @quarantined"` now runs exactly the 2 tests preview shows, with a correct, schema-valid run manifest. Separately exercised DEC-018's disclosed production-guard gap live (a bare `playwright test --grep` with an ambient `PLAYWRIGHT_ALLOW_PRODUCTION=1` genuinely ran a mutating test against a simulated production host with `pw:run` never involved) and judged it an acceptable, honestly-disclosed limitation rather than blocking, given `PRODUCTION_HOSTNAMES` defaults to empty (DEC-005, so currently dormant) and both `PLAYWRIGHT_TESTING.md`/`README.md` state the mitigation directively rather than burying it. One Medium finding (an expression with ~3000+ levels of nested parentheses crashes with a raw, uncaught `RangeError` instead of a friendly message — the recursive-descent parser has no depth guard; fails safely, no incorrect selection, judged not worth the surgery of a rewrite for a pathological, not realistic, input shape) and two Low findings (`--selection` immediately followed by another recognized flag misreads that flag as the selection name rather than refusing it; a test title that itself literally contained `@tag`-shaped prose text could theoretically satisfy an unrelated expression via `--grep`'s own title-matching design — no current title does) were logged and deliberately left open. A small doc-accuracy correction was also made: `quality/saved-selections.yaml`'s `readonly` description omitted that DEC-017 requires `--allow-production` on top of the env var; corrected | `pnpm exec tsc --noEmit` clean before and after; `pnpm pw:test` — **194/194 passed** (189 pre-fix, matching the implementer's claim, + 5 new locking tests: 1 in `tagExpression.spec.ts`, 4 in `buildPlaywrightInvocation.spec.ts`); `pnpm pw:validate` clean (`Total: 194 tests in 19 files`); `git status --short` at the end showed only legitimate source changes and the audit report itself — no scratch/probe files left behind | `playwright-framework/runner/tagExpression.ts` (tag-boundary anchor added), `playwright-framework/runner/buildPlaywrightInvocation.ts` (new), `playwright-framework/cli/run-tests.ts` (spawns matched spec files alongside `--grep`), `playwright-framework/tests/tagExpression.spec.ts` (new locking test), `playwright-framework/tests/buildPlaywrightInvocation.spec.ts` (new), `quality/saved-selections.yaml` (description correction), `quality/audits/stage-05-audit.md` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: Stage 05 audit gate checkboxes, Progress Dashboard, this row) | Commit Stage 05 (blocked on BLK-001 for push/PR only); begin Stage 06 — Test-run reporting and diagnostic artifacts |
| 2026-09-10 | 06 | Implemented the full Stage 06 test-run reporting system. `playwright-framework/reporting/normalizedReporter.ts`: a custom Playwright `Reporter` writing one normalized `RunReport` (new schemas in `schemas.ts`: `RunReportSchema`/`RunReportTestSchema`/`StepOutcomeSchema`/`SuccessCheckpointSchema`/`RunReportCountsSchema`) per run, classifying every test into the 8 Section 10.2 categories from Playwright's own `TestCase.outcome()`/`TestResult.status` (never guessed), reading governed metadata back from the `defineQualityTest` annotations, counting real executed `expect`-category steps (`assertionCount`), collecting named Arrange/Act/Assert steps, classifying attachments into success-checkpoint screenshots/failure screenshot/trace/video/console-messages/failed-network-requests by the existing `e2e/support/evidence.ts` naming convention, sanitizing every error message/stack trace/diagnostic text through the existing `redact()`, and generating deterministic plain-language why-passed/why-failed explanations. `renderRunReportHtml.ts`: a pure function rendering the validated report to a single self-contained HTML file (inlined CSS, light/dark via `prefers-color-scheme`, a real `<table>`/`<details>` semantic structure, status conveyed by symbol+text never color alone, a client-side search/filter over title/ID/tags with no network calls). Registered in `playwright.config.ts` alongside the native `list`/`html` reporters. `playwright-framework/validation/discoverAllTests.ts`: a shared AST-based discovery helper (factored out for this stage's own "how many tagged application tests exist in total" need, reusing the same walk `pw:lint-tests`/`pw:run` already do inline). `playwright-framework/cli/serve-run-report.ts` (`pnpm pw:report:run`): a small dependency-free `node:http` static server for `artifacts/playwright/runs/` so a report's relative links (native report, screenshots, traces) resolve exactly as `pnpm pw:report` already does for the native report alone, with a basic path-containment check against directory traversal. `run-tests.ts` updated to generate `runId` before spawning the child process and pass it via `PW_RUN_ID` (plus `PW_RUN_TAG_EXPRESSION`/`PW_RUN_INITIATOR`) so a `pw:run`-launched run's Stage 05 manifest and Stage 06 report share one `runId` without merging or cross-process coordination. Manual verification (real `playwright test` runs against the live app, not just unit assertions) caught two real bugs before any audit ran: **(1)** every `defineQualityTest`-wrapped test's reported `filePath`/`line` pointed at the wrapper's own internal call site (`defineQualityTest.ts:87`) rather than the real spec file — Playwright resolves `TestCase.location` to wherever `test()`/`testFn()` is textually invoked during collection, which for a wrapped test is always inside the wrapper module. Fixed (DEC-019) by building a `testId -> {filePath, line}` lookup from `discoverAllApplicationTests()`'s own AST-derived data (computed once, before the per-test loop, reusing what the reporter already needed for `excludedCount`) and overriding the two fields when a test's ID is found there, falling back to Playwright's own `test.location` only for tests that don't go through the wrapper (`framework-health.spec.ts`, `e2e/tests/unit/*.spec.ts`). Verified live with a mixed run of both kinds of test: all three entries reported correct `filePath`/`line`. **(2)** `TestResult.status === "interrupted"` (Playwright's fifth status, alongside passed/failed/timedOut/skipped) had no explicit branch in `classifyOutcome` and reached `setup-failure` only via unclaimed fallthrough, with a comment that was actively wrong for that case — made explicit (DEC-020), behavior-preserving. Wrote `playwright-framework/tests/runReportHtml.spec.ts`: 4 tests launching a real throwaway Chromium instance (this project has no browser-enabled `framework-unit` project; same sandbox executable-path workaround `playwright.config.ts` already documents) and using `page.setContent()` against synthetic `RunReport` fixtures covering all 6 of the acceptance criterion's representative statuses (initial-pass, consistent-failure, timeout, retry-pass, skipped, setup-failure) plus an empty-run case, asserting via real Playwright locators — not string/regex matching against the HTML source, which would miss a markup mistake in the wrong place or a broken client script. Updated `PLAYWRIGHT_TESTING.md` (new "Test-run reports" section: report location, `pw:report:run` usage, the shared-`runId` relationship with Stage 05's manifest, the 8 status categories in a table, what each test's entry contains, the location-correction mechanism, redaction/path handling, and the failure mode) and `README.md`'s Playwright section (Reports bullet, Layout bullet, new Stage 06 bullet, "as of Stage 06" references) | `pnpm exec tsc --noEmit` clean throughout (including after both bug fixes). Fixed the location bug, then re-ran `pnpm exec playwright test --project=chromium e2e/tests/guest-viewing.spec.ts` for real (confirmed WITHOUT `--reporter=list`, which was separately discovered to silently replace the entire configured reporter array rather than add to it) and inspected the regenerated JSON: `filePath`/`line` now read `e2e/tests/guest-viewing.spec.ts:23`, matching the real `defineQualityTest(` call site (`grep -n` confirms line 23), instead of the wrapper. A dedicated temporary scratch spec (deleted immediately after use, never committed) exercised passed/consistently-failed/flaky-then-passed/skipped/quarantined-skip against the real reporter with `--retries=1`: all 5 statuses classified correctly, and non-`defineQualityTest` tests correctly fell back to `test.location` (cross-checked against the real source lines). The rendered HTML for that run was opened in a real launched Chromium page (`page.goto('file://...')`) with zero `pageerror`/console-error events, the correct status text present, and the client-side search filter verified to actually hide/show rows, not just contain the right substrings. `runReportHtml.spec.ts` — **4/4 passed** after fixing two of my own locator ambiguities caught by real test failures (a substring `hasText` match ("Passed") also matching "Passed on retry (flaky)"; a bare `summary` descendant selector matching both the row's own `<summary>` and a nested `<details><summary>Stack trace</summary></details>` further down in the same row) — fixed with an exact-match regex helper and a `> summary` direct-child selector, respectively, not by loosening the assertions. `pnpm pw:test` — **198/198 passed** (194 carried over + 4 new). `pnpm pw:validate` clean (`Total: 198 tests in 20 files`). `pnpm pw:report:run` manually verified end-to-end: started the server, and `curl` confirmed 200 for the report HTML, its JSON, the linked native Playwright HTML report, and a linked success-checkpoint screenshot, plus a 404 (not a leaked file) for a `../../../etc/passwd` traversal attempt; server then stopped and confirmed no longer running (`ps aux` check). All scratch/temporary files (verification spec, HTML-check script, generated run artifacts) deleted after use; `git status --short` at the end shows only legitimate Stage 06 source files | `playwright-framework/reporting/{normalizedReporter,renderRunReportHtml,constants}.ts` (new), `playwright-framework/validation/discoverAllTests.ts` (new), `playwright-framework/cli/serve-run-report.ts` (new), `playwright-framework/cli/run-tests.ts` (runId generated earlier, passed via `PW_RUN_ID`/`PW_RUN_TAG_EXPRESSION`/`PW_RUN_INITIATOR`, run-report hint line printed), `playwright-framework/metadata/schemas.ts` (`RunReportSchema` family added), `playwright-framework/tests/runReportHtml.spec.ts` (new), `playwright.config.ts` (reporter array extended), `package.json` (`pw:report:run` script), `PLAYWRIGHT_TESTING.md` ("Test-run reports" section), `README.md` (Playwright section updated for Stage 06), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: DEC-019, DEC-020, Stage 06 task checkboxes, this row) | Dispatch an independent fresh-context audit subagent for Stage 06; on PASS, write `quality/audits/stage-06-audit.md`, check the Stage 06 Progress Dashboard box, commit, and (once BLK-001 clears) open PRs for Stages 02–06 |
| 2026-09-10 | 06 | Independent audit (fresh context, no memory of the implementation) completed and PASSED WITH FINDINGS. The audit cross-checked the reporter's JSON `counts`/`selectionSummary` against Playwright's own native terminal summary three ways — a full unfiltered `pnpm pw:test` run, a `pw:run`-filtered single-tag run, and a raw invocation mixing one application test with several unrelated unit tests — which is what surfaced Finding 1 below, not present in the pre-existing test suite. **Finding 1 (High, fixed):** `selectionSummary.excludedCount` could silently read 0 for a run that genuinely excluded a real application test: the old formula subtracted the count of every test that ran (of any kind) from the count of only discovered application tests, and clamped negative results to 0. Reproduced live (1 of 2 real application tests ran, alongside 11 unrelated unit tests — 12 ran in total, more than 2, so `2 - 12` clamped to a false "0 excluded"). Fixed via identity-based matching in a new `countExcludedApplicationTests`; 5 new locking tests. **Finding 2 (High, fixed):** raw ANSI terminal escape codes from Playwright's own error/stack-trace text were never stripped, corrupting the visible error message and "why this failed" summary — reproduced live against a real deliberately-failing test (`errorMessage` contained literal `\x1b[31m...` sequences, confirmed in a real rendered browser page's `innerText()`). Fixed with a new `stripAnsi()` inside the reporter's `sanitize()`; 3 new locking tests. **Finding 3 (High, fixed):** a skipped or quarantined test's `whyFailed` field falsely claimed "Failed, but no specific failing named step was recorded" — `buildWhyExplanation` had no explicit branch for either status, so both fell through to the failure catch-all. Reproduced live with a real `test.skip()`-tagged `@quarantined` test. Fixed with an explicit branch returning neither `whyPassed` nor `whyFailed` for a test that never ran; 3 new locking tests (including a control case proving real failures still get their explanation). **Finding 4 (High, fixed):** status badge colors failed WCAG AA contrast in dark mode — the light-mode `--pass`/`--fail`/`--warn` values were reused verbatim under `prefers-color-scheme: dark`, measuring 2.4–3.1:1 (computed via the WCAG relative-luminance formula) against the actual dark background/card background, both well under the 4.5:1 minimum. Fixed with dark-mode-specific color values, each verified ≥4.5:1 against both backgrounds; 1 new locking test (renders the real fixture in both color schemes and computes the actual ratio, not a hardcoded expectation). **Finding 5 (High, fixed):** `pw:run` printed a confident "Run report: ...html" hint even when Playwright's own documented `--reporter <value>` flag (recommended by the CLI's own `--help` text) silently replaced its whole configured reporter array and no run report was written at all — reproduced live, confirming the hinted file did not exist on disk. Fixed by checking `existsSync` before choosing the message, extracted into a new testable `playwright-framework/runner/runReportHint.ts`; 4 new locking tests. Every one of the five fixes was confirmed to fail its own new locking test against a temporarily-reverted pre-fix version before being trusted. Two Medium findings (a non-functional "All statuses" filter checkbox with no wired event listener; no sort control for the test list despite Section 10.1's "sortable ... tables") and two Low findings (the search box's help text undersells what it actually matches; `selectionSummary.matchedCount` counts every executed test rather than being scoped like `excludedCount` now is) were logged and deliberately left open, consistent with the Stage 05 audit's precedent of disclosing non-blocking findings rather than fixing everything | `pnpm exec tsc --noEmit` clean before, during, and after every fix; `pnpm pw:test` — **214/214 passed** (198 pre-fix, matching the implementer's claim, + 16 new locking tests: 11 in a new `normalizedReporter.spec.ts`, 1 added to `runReportHtml.spec.ts`, 4 in a new `runReportHint.spec.ts`); `pnpm pw:validate` clean (`Total: 214 tests in 22 files`); redaction wiring re-verified end-to-end with a fake `Bearer` token embedded in a real checkpoint validation description, confirmed redacted in the generated JSON; `pw:report:run` re-verified live via `curl` (report HTML/JSON, native report, and a traversal attempt all behaving as claimed, server confirmed stopped afterward); a real forced flaky test (`--retries=1`) confirmed `retry-pass` classification agrees with Playwright's own "1 flaky" with no bug found; `git status --short` at the end showed only legitimate source changes, this report, and the audit's own new test files — no scratch/probe files left behind, nothing under `apps/`/`packages/` touched | `playwright-framework/reporting/normalizedReporter.ts` (`countExcludedApplicationTests`, `stripAnsi`, `buildWhyExplanation` fix, all exported), `playwright-framework/reporting/renderRunReportHtml.ts` (dark-mode color fix), `playwright-framework/cli/run-tests.ts` (honest run-report hint), `playwright-framework/runner/runReportHint.ts` (new), `playwright-framework/tests/normalizedReporter.spec.ts` (new), `playwright-framework/tests/runReportHtml.spec.ts` (contrast test added), `playwright-framework/tests/runReportHint.spec.ts` (new), `quality/audits/stage-06-audit.md` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: Stage 06 audit gate checkboxes, Progress Dashboard, Persistent Implementation State, this row) | Begin Stage 07 — Suite review, coverage analysis, and test catalog; once BLK-001 clears, commit Stage 06 (and open PRs for Stages 02–06) |
| 2026-09-10 | 07 | Implemented the full Stage 07 suite-review system. New `playwright-framework/coverage/`: `runReportHistory.ts` (reads Stage 06's gitignored run-report JSON files, tolerating zero/invalid files exactly like a first-ever run), `computeCoverage.ts` (`classifyTestHealth`; `computeRequirementCoverage` — denominator excludes `placeholder`/`retired` requirements, states the exclusion count; `computeRiskWeightedCoverage`, DEC-022 — an uncovered requirement conservatively weighted as `@risk:critical`, proven to never read higher than plain coverage; `computeDimensionCoverage` over whatever taxonomy dimensions exist, including zero-use tags), `detectDuplicates.ts` (flags a pair only on shared requirement + SAME data-impact tag + shared feature tag + objective similarity >= 0.5 — proven the real `guest-viewing`/`guest-management` pair is correctly never flagged), `buildReviewQueue.ts` (additive, documented point values; deliberately excludes "value score is provisional on the 4 forced business criteria" as a reason, since that's true suite-wide today and would swamp the queue), `diffSuiteReviews.ts` (added/removed tests, per-test score-total changes, `findMostRecentSuiteReviewPath`). New `playwright-framework/evaluation/evaluateTest.ts` (DEC-021's mechanical/hand-authored/forced-needs-human-review three-way split across all 14 value+quality criteria) and `quality/test-evaluations.yaml` (hand-authored entries for both real tests). New `playwright-framework/reporting/renderSuiteReviewHtml.ts` (self-contained HTML, same accessible/offline posture as Stage 06's renderer; search plus quarantined/needs-review/stale-or-never-executed checkboxes and risk/feature/result/value-band/quality-band select filters). New `playwright-framework/cli/suite-review.ts` (`pnpm pw:review`) orchestrating discovery, governance-file loading, coverage/duplicate computation, per-test evaluation, `computeScore`/`applyOverride`, review-queue, diff-against-previous, `SuiteReviewSchema` validation, and JSON+HTML write, plus `playwright-framework/cli/serve-suite-review.ts` (`pnpm pw:review:serve`). New `playwright-framework/version.ts` (`FRAMEWORK_VERSION`, DEC-023). `metadata/schemas.ts` extended with the full `SuiteReview` schema family (real structural `CriterionResultSchema`/`ScoreResultSchema` — caught myself initially reaching for `z.custom` placeholders, which would not have structurally validated anything, before any test ran) and `TestEvaluation*` schemas; `metadata/loaders.ts` got `loadTestEvaluations`. Manual/real-command verification, not just unit assertions: started the app's own Postgres cluster (`pg_ctlcluster 16 main start`) and `pnpm dev`, ran the real suite via `pnpm pw:run "@suite:regression"` (2/2 passed for real, producing real Stage 06 run-report history), then generated a real suite review via `pnpm pw:review` three times in succession — the second/third runs confirmed `diffSuiteReviews` correctly finds and reads the most recent prior review from disk (real files, not mocked). Hand-verified the real scores against the criterion math (guest-viewing: 15 unique-coverage + 5 security-compliance = 20 value; 20+19+15+15+8+10+5+5 = 97 quality; guest-management: 15+7 = 22 value; 20+18+15+15+8+10+5+5 = 96 quality — both match the generated JSON exactly). Exercised the human-override code path for real: added a temporary `criterion-score` override to `quality/value-overrides.yaml` (unique-coverage 15 to 10), re-ran `pnpm pw:review`, confirmed the JSON showed `source: "override"`, a re-derived total (20 to 15), and a populated `overrideRef`, and the HTML rendered the "Human override" callout, then reverted the file and confirmed via `git diff` that it was back to its committed empty-array state before regenerating a clean final review. Opened the real generated HTML in a real headless Chromium (`page.goto('file://...')`, screenshotted) and visually inspected the full report — coverage table, dimension coverage, duplicate section, score distributions, review queue, changes section, and an expanded test's full criterion breakdown all rendered correctly. Wrote `PLAYWRIGHT_TESTING.md`'s "Suite review, coverage analysis, and test catalog" section and updated `README.md`'s Playwright section (Layout bullet, new Stage 07 bullet) | `pnpm exec tsc --noEmit` clean throughout; **43 new unit tests, all passing on top of the 211 carried over** — `evaluateTest.spec.ts` (27: every mechanical criterion's branches, hand-authored-present/missing, business-criteria-always-needsHumanReview, unique-coverage overlap/no-overlap including the real guest pair), `buildReviewQueue.spec.ts` (10: exclusion-when-healthy, never-executed/failing/stale ordering, at-risk-unhealthy-requirement gating by risk tier, duplicate-candidate reasons, high-value-poor-quality bonus, missing-hand-authored-evaluation, disproportionate-execution-time, stable tie-break), `diffSuiteReviews.spec.ts` (6), `runReportHistory.spec.ts` (4), `computeCoverage.spec.ts` (13), `detectDuplicates.spec.ts` (7), `suiteReviewHtml.spec.ts` (10 real-browser DOM tests, including one against the actual just-generated report file on disk, not only synthetic fixtures); `pnpm pw:test` (framework-unit project) — **254/254 passed**; `pnpm pw:validate` clean (`Total: 291 tests in 29 files`); `git status --short` at the end shows only legitimate Stage 07 source/doc changes and new test files — the temporary override probe left no residue in `quality/value-overrides.yaml`, no scratch files remain, nothing under `apps/`/`packages/` touched | `playwright-framework/coverage/{runReportHistory,computeCoverage,detectDuplicates,buildReviewQueue,diffSuiteReviews}.ts` (new), `playwright-framework/evaluation/evaluateTest.ts` (new), `playwright-framework/reporting/renderSuiteReviewHtml.ts` (new), `playwright-framework/cli/{suite-review,serve-suite-review}.ts` (new), `playwright-framework/version.ts` (new), `playwright-framework/metadata/schemas.ts` (SuiteReview schema family + TestEvaluation schemas added), `playwright-framework/metadata/loaders.ts` (`loadTestEvaluations`), `quality/test-evaluations.yaml` (new), `playwright-framework/tests/{evaluateTest,buildReviewQueue,diffSuiteReviews,runReportHistory,computeCoverage,detectDuplicates,suiteReviewHtml}.spec.ts` (new), `package.json` (`pw:review`/`pw:review:serve` scripts), `PLAYWRIGHT_TESTING.md`/`README.md` (Stage 07 sections), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (DEC-021/022/023, Stage 07 task/acceptance-criteria checkboxes, Persistent Implementation State, this row) | Dispatch an independent, fresh-context Stage 07 audit subagent; independently re-verify its claims; on PASS, write `quality/audits/stage-07-audit.md`, check the Stage 07 Progress Dashboard box, commit, and begin Stage 08 — Claude Code skills, commands, subagents, and hooks |
| 2026-09-10 | 07 | Independent audit (fresh context, no memory of the implementation) completed and PASSED WITH FINDINGS. The audit read `computeCoverage.spec.ts`/`detectDuplicates.spec.ts` first to target genuine gaps rather than duplicate existing coverage, then hand-traced both real tests' value/quality criterion-by-criterion against real lint output (`pnpm pw:lint-tests`), real run-report data (a fresh `pnpm pw:run "@suite:regression"`), and `quality/test-evaluations.yaml`'s own hand-authored rationale re-read against the actual test source — every rationale found honest, every point value justified, nothing overstated. **Finding 1 (High, fixed):** `evaluateTest.ts`'s `unique-coverage` overlap check used a hardcoded `0.3` objective-similarity threshold while `detectDuplicates.ts`'s own `SIMILARITY_THRESHOLD` is `0.5` — two independently-drifted numbers, contradicting `PLAYWRIGHT_TESTING.md`'s explicit claim that unique-coverage "reuses the identical comparison" as duplicate detection. Reproduced live with an adversarial synthetic test pair engineered to land in the 0.3–0.49 gap (similarity 0.4286, directly computed): `detectDuplicates()` correctly found 0 candidates, while `evaluateTestValue()` on the same pair reduced unique-coverage from 15 to 8 points with a rationale naming the "overlap" — a self-contradictory report for identical evidence. The real 2-test suite never hit this only because the two real tests differ on data-impact tag (filtered out before similarity is even checked), not because the threshold was ever actually consistent. Fixed by exporting and sharing `detectDuplicates.ts`'s own `SIMILARITY_THRESHOLD` constant instead of a second hardcoded copy; 1 new locking test in `evaluateTest.spec.ts`, confirmed to fail (points drop to 8) against a temporarily-reverted pre-fix version before being trusted. **Finding 2 (High, fixed):** every suite-review source-file link 404'd when viewed via `pnpm pw:review:serve` — the one documented way `PLAYWRIGHT_TESTING.md` claims makes links "resolve." `renderSuiteReviewHtml.ts`'s href for a test's source file is authored with 4 `../` segments (relative to `artifacts/playwright/runs/suite-reviews`, 3 levels below the repo root), but a served suite-review page's own URL is only 1 directory deep (`/suite-reviews/<id>.html`) — a real browser's URL resolution can use only 1 of those 4 `../` before clamping at the server's own URL root, landing on `/e2e/tests/<file>`, which the old server (rooted at `artifacts/playwright/runs`, with no `e2e/` subdirectory) could never serve. Reproduced live: started the real server, opened the real generated HTML in a real headless Chromium, read both `.test-source a` hrefs, resolved them exactly as a browser would, and got a real 404 for both. Widening the server root to the whole repo was considered and rejected (this repo has a real `.env` at its root, which would have become newly servable). Fixed instead with a new pure `playwright-framework/reporting/servedPath.ts` (`candidatePathsForRequest`) that falls back, only when the primary `artifacts/playwright/runs` root misses, to an explicit two-directory allowlist (`e2e/`, `playwright-framework/`) under the repo root — never the bare repo root itself. Re-verified live after the fix: both source links now return real 200s with correct file content through the real server; `.env` and a 6-level `../../../../../../etc/passwd` traversal attempt both still 404. 6 new locking tests in `servedPath.spec.ts`, 2 confirmed to fail against a temporarily-reverted single-root version before being trusted. Also live-verified beyond what these two findings cover: risk-tag cardinality (`exactly-one`, matching `data-impact`, confirmed in `quality/tag-taxonomy.yaml` and enforced by `tagValidation.ts` — a test can never actually have zero risk tags), value/quality-band boundary scores (90, 75, 50, 25 each match exactly one non-overlapping band, no double-count), every value/quality criterion ID's 1:1 wiring against `quality/test-value-model.yaml`'s 6 value + 8 quality criteria (no typos; `computeScore`'s "unknown criterion" throw is proven to actually fire, not dead code, by Stage 02's own pre-existing `scoring.spec.ts`), a real temporary `quality/value-overrides.yaml` override (criterion-score, reverted, confirmed via `git diff` showing no residual change) applying and rendering correctly, a real `--freshness-window-days` override (isolated a single real run-report file, edited its `endedAt` 20 days into the past, confirmed stale classification and review-queue entries, then fully restored every original file byte-for-byte), and both zero-discovered-tests and missing-`quality/*.yaml`-file invocations producing a loud, clear error and nonzero exit rather than a crash. No Medium/Low findings are carried forward — every additional edge case probed held up | `pnpm exec tsc --noEmit` clean before, during, and after both fixes; `pnpm pw:test` — **298/298 passed** (291 pre-fix, matching the implementer's claim, + 7 new locking tests: 1 in `evaluateTest.spec.ts`, 6 in a new `servedPath.spec.ts`); `pnpm pw:validate` clean (`Total: 298 tests in 30 files`); `git status --short` at the end showed only legitimate source/test changes and this report — no scratch/probe files left behind (all deleted immediately after use), nothing under `apps/`/`packages/`/application source touched, the temporary value-override and edited run-report both fully reverted and diff-confirmed clean | `playwright-framework/coverage/detectDuplicates.ts` (`SIMILARITY_THRESHOLD` exported), `playwright-framework/evaluation/evaluateTest.ts` (imports and reuses the shared threshold instead of a hardcoded `0.3`), `playwright-framework/reporting/servedPath.ts` (new), `playwright-framework/cli/serve-suite-review.ts` (uses the new allowlisted resolver), `playwright-framework/tests/evaluateTest.spec.ts` (1 new locking test), `playwright-framework/tests/servedPath.spec.ts` (new), `quality/audits/stage-07-audit.md` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: Stage 07 audit gate checkboxes, Progress Dashboard, Persistent Implementation State, this row) | Begin Stage 08 — Claude Code skills, commands, subagents, and hooks; once BLK-001 clears, commit/push and open PRs for Stages 02–07 |
| 2026-09-10 | 08 | Implemented the full Section 11 Claude Code integration layer. `.claude/skills/` — all 7 required skills (`pw-bootstrap`, `pw-author-test`, `pw-run-tests`, `pw-review-suite`, `pw-triage-failures`, `pw-repair-test`, `pw-validate-framework`), each `SKILL.md` stating when/when-not to use it, required arguments, allowed file-change scope, preflight, the real `pnpm pw:*` commands it delegates to (never reimplementing tag parsing or scoring in prose), expected output, stop conditions, and an explicit prohibition on silently changing application behavior or test expectations; `/pw-repair-test` sets `disable-model-invocation: true` (human-only invocation) and `context: fork`/`agent: playwright-repair`. `.claude/agents/` — `playwright-reviewer` and `playwright-triage` (`tools: Read, Grep, Glob, Bash`, no Write/Edit/NotebookEdit) and `playwright-repair` (`tools: Read, Grep, Glob, Bash, Edit, Write`, hook-guarded). `.claude/hooks/` — four scripts, each a plain, dependency-light Node `.mjs` reading one JSON object from stdin and emitting a documented `hookSpecificOutput`/exit-code decision (`lib/hookIO.mjs` factors the shared stdin-parsing/allow/deny/no-op helpers): `repair-write-guard.mjs` (hook requirement #1 — DEC-024/025's two-layer approved-directory-plus-session-scope check, wired only into `playwright-repair`'s own frontmatter), `post-edit-validator.mjs` (requirement #2 — project-wide `PostToolUse`, runs only `tsc --noEmit`/`pw:lint-tests`/`pw:validate-metadata` depending on what changed, never a browser-backed project), `stage-gate-check.mjs` (requirement #3 — project-wide `PreToolUse`, DEC-026's `Result: PASS` convention check, scoped internally to the one spec file), and a shared `readonly-bash-guard.mjs` (used by all three subagents to deny Write/Edit/NotebookEdit outright and block a documented, conservative Bash mutation-pattern blocklist). New, human-owned `quality/repair-allowed-dirs.yaml` (`e2e/tests`, `e2e/pages`, `e2e/components` — DEC-025). Current Claude Code documentation for hooks/skills/subagents (`code.claude.com/docs/en/{hooks,skills,sub-agents}`) was fetched and read directly before writing any hook or frontmatter field, per the task's own "use current documented syntax" requirement — the exact `hookSpecificOutput.permissionDecision`/exit-2/`${CLAUDE_PROJECT_DIR}` contract and subagent-frontmatter-scoped `hooks:` field both came from that live read, not assumed from training data. Manual verification before any formal test existed: every hook script `node --check`ed, then manually invoked with representative allowed/denied/malformed/missing stdin and its exact JSON/exit-code output inspected by hand. Wrote `playwright-framework/tests/hooks/{repairWriteGuard,stageGateCheck,postEditValidator,readonlyBashGuard}.spec.ts` (35 tests total, each spawning the real on-disk script as a `node` child process with real stdin — never importing internals, since a hook has none to import) plus a shared `runHook.ts` test helper; the two guards with filesystem dependencies (`repair-write-guard`, `stage-gate-check`) run against a throwaway temporary fake repository root per test, never this real repo's own files. This stage's own tests caught two real bugs before any audit ran: (1) the `readonly-bash-guard`'s `git checkout --` mutation pattern never matched anything, because a regex `\b` word boundary can never exist between two non-word characters (`-` then a space) — fixed by dropping the trailing `\b`; (2) a test's own wrong expectation of `post-edit-validator`'s multi-check message format (expected `"tsc --noEmit passed"` as a literal substring; the real format joins multiple check labels before a single "passed for ..." suffix) — fixed the test, not the script. Updated `PLAYWRIGHT_TESTING.md` (new "Claude Code integration (Stage 08)" section: skills/subagents/hooks tables, the repair-write-guard's two-layer design, the post-edit-validator's per-file-type check selection, the stage-gate-check's `Result: PASS` dependency, how the hooks are tested, and behavior when Claude Code features are unavailable) and `README.md` (Layout bullet, new Stage 08 bullet, bumped the "as of Stage NN" reference). Bumped `FRAMEWORK_VERSION` to `"0.8.0"` (DEC-023's convention) | `pnpm exec tsc --noEmit` clean throughout; **35 new unit tests, all passing on top of the 298 carried over** — `repairWriteGuard.spec.ts` (11), `stageGateCheck.spec.ts` (9), `readonlyBashGuard.spec.ts` (7), `postEditValidator.spec.ts` (9); `pnpm pw:test` — **333/333 passed**; `pnpm pw:validate` clean (`Total: 333 tests in 34 files`); `git status --short` at the end shows only legitimate new Stage 08 files (`.claude/`, `quality/repair-allowed-dirs.yaml`, `playwright-framework/tests/hooks/`) and doc/ledger/version edits — no scratch files, nothing under `apps/`/`packages/` touched | `.claude/skills/{pw-bootstrap,pw-author-test,pw-run-tests,pw-review-suite,pw-triage-failures,pw-repair-test,pw-validate-framework}/SKILL.md` (new), `.claude/agents/{playwright-reviewer,playwright-triage,playwright-repair}.md` (new), `.claude/hooks/{lib/hookIO,repair-write-guard,post-edit-validator,stage-gate-check,readonly-bash-guard}.mjs` (new), `.claude/settings.json` (new), `quality/repair-allowed-dirs.yaml` (new), `playwright-framework/version.ts` (bumped to 0.8.0), `playwright-framework/tests/hooks/{runHook,repairWriteGuard,stageGateCheck,postEditValidator,readonlyBashGuard}.{ts,spec.ts}` (new), `PLAYWRIGHT_TESTING.md`/`README.md` (Stage 08 sections), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (DEC-024/025/026, Stage 08 task/acceptance-criteria checkboxes, Persistent Implementation State, this row) | Dispatch an independent, fresh-context Stage 08 audit subagent that actually invokes the real subagents and attempts real unauthorized writes through the repair workflow, not just re-reads the hook scripts; independently re-verify its claims; on PASS, write `quality/audits/stage-08-audit.md`, check the Stage 08 Progress Dashboard box, commit, and begin Stage 09 — Failure triage and controlled test repair |
| 2026-09-10 | 08 | Independent audit (fresh context, no memory of the implementation) completed and PASSED WITH FINDINGS. Re-verified the implementer's exact numbers first (`pnpm exec tsc --noEmit` clean; `pnpm pw:test` 333/333; `pnpm pw:validate` `Total: 333 tests in 34 files`), then read every hook script, subagent, and skill file in full before running anything. This sandboxed session has no live `Task`/`Skill` harness for this repository's own custom subagents (`ListAgents` shows only a `general-purpose` subagent; invoking `pw-repair-test` by name via `Skill` returns `Unknown skill: pw-repair-test`) — disclosed rather than worked around, matching the implementer's own already-disclosed limitation. The next-most-rigorous available substitute — direct invocation of the real, on-disk hook scripts with the exact stdin shape Claude Code sends for each subagent's wired matcher, against throwaway fake repository roots under this session's own scratchpad (never this repo's own files) — is what surfaced all three findings below. **Finding 1 (High, fixed):** `repair-write-guard.mjs` never resolved symlinks, so a symlink placed inside an approved directory (e.g. `e2e/tests/looks-legit.spec.ts` pointing at `apps/web/src/foo.ts`) was `allow`ed even though the actual write lands entirely outside every approved path. Reproduced live with a real `symlinkSync` in a fake repo root; fixed with a `realpathSync`-based comparison (against the *root's own* real path plus the same relative path, so a project root itself reached via a symlink is not mistaken for a target-side escape); re-verified live (denied post-fix, real target file confirmed unchanged); 1 new locking test in `repairWriteGuard.spec.ts`, confirmed to fail against the pre-fix script first. **Finding 2 (High, fixed):** `readonly-bash-guard.mjs`'s Bash mutation blocklist — the *only* Bash defense for `playwright-reviewer`/`playwright-triage`, and the *only* defense of any kind against `playwright-repair` writing via `Bash` (a channel `repair-write-guard.mjs` never governs) — had zero coverage for interpreter-based writes. Reproduced live: `node -e "require('fs').writeFileSync(...)"`, `python3 -c "open(...).write(...)"`, `git restore <file>`, and `ln -sf /etc/passwd <path>` were all `allow`ed by the pre-fix script. Fixed by adding patterns for `node -e/--eval/-p/--print`, `python(3) -c`, `perl -e/-i`, `ruby -e`, `php -r`, `deno eval`, `ln`, and extending the mutating-git-subcommand pattern with `restore`/`apply`/`stash pop`/`merge`/`rebase`/`cherry-pick` (disclosed as still non-exhaustive by design — a blocklist can never enumerate every language). A first attempt at this fix accidentally reintroduced the exact `git checkout --` word-boundary bug this stage's own tests already found once, by adding a trailing `\b` to the whole extended alternation group — caught immediately by the pre-existing `readonlyBashGuard.spec.ts` test failing before any new locking test was even written, and fixed by leaving the group unanchored on the right as the original script already did. 9 new bypass commands added as a locking test in `readonlyBashGuard.spec.ts`, confirmed to fail against the pre-fix script first. **Finding 3 (High, fixed):** `stage-gate-check.mjs` checked whether a `Result: PASS` line existed ANYWHERE in an audit file rather than checking the file's own actual first verdict line — an audit file whose real first line honestly said `Result: FAIL` but which also happened to contain an unrelated `Result: PASS` line elsewhere (e.g. a quoted appendix example) was `allow`ed by the pre-fix script, exactly the failure mode DEC-026's gate exists to prevent. Fixed by finding only the first line matching `/^Result:\s*/` and checking that one's value; 1 new locking test in `stageGateCheck.spec.ts` (plus one pre-existing test's message-substring assertion updated to match the corrected, more precise wording), confirmed to fail against the pre-fix script first. Also corrected `PLAYWRIGHT_TESTING.md`'s description of the stage-gate check to match the fix. No Medium/Low findings are being carried forward — every other adversarial case probed (directory-prefix sibling attacks, absolute vs. relative paths, case/trailing-slash mismatches in the scope file, path traversal, nonexistent-directory-allowlist smuggling, every `SKILL.md`'s stated scope against its actual enforced allowlist, and a live cross-check of `code.claude.com/docs/en/{hooks,sub-agents,skills}` against every frontmatter/hook field actually used) held up | `pnpm exec tsc --noEmit` clean before, during, and after all three fixes; `pnpm pw:test` — **336/336 passed** (333 pre-fix, matching the implementer's claim, + 3 new locking tests, one per finding, added into the existing hook spec files rather than new files); `pnpm pw:validate` clean (`Total: 336 tests in 34 files`); `git status --short` at the end showed only legitimate Stage 08 fix files, this report, and ledger/doc updates — no scratch/probe files left behind (every fake repository root and in-memory pre-fix backup was deleted immediately after use), nothing under `apps/`/`packages/`/application source was ever actually touched (the one "attack" targeting `apps/web/src/foo.ts` only ever existed inside a throwaway fake repository root) | `.claude/hooks/repair-write-guard.mjs` (symlink/realpath check added), `.claude/hooks/readonly-bash-guard.mjs` (interpreter-eval, `ln`, and extended git-subcommand patterns added), `.claude/hooks/stage-gate-check.mjs` (checks only the audit file's own first `Result:` line), `playwright-framework/tests/hooks/{repairWriteGuard,readonlyBashGuard,stageGateCheck}.spec.ts` (1 new locking test each, plus one corrected pre-existing assertion), `quality/audits/stage-08-audit.md` (new), `PLAYWRIGHT_TESTING.md` (stage-gate-check description corrected), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Stage 08 audit gate checkboxes, Progress Dashboard, Persistent Implementation State, this row) | Begin Stage 09 — Failure triage and controlled test repair; once BLK-001 clears, commit/push and open PRs for Stages 02–08 |
| 2026-09-11 | 09 | Replaced the stale, unused Stage 02 placeholder schema (`MaintenanceClassificationSchema`/`MaintenanceFindingSchema`/`MaintenanceResultFileSchema`, confirmed dead via `grep -rln` before deletion) with a real Section-10.4-compliant `MaintenanceFindingSchema`/`MaintenanceReportSchema` — 7 categories, 12 required fields (DEC-027). Built `playwright-framework/triage/classifyFailure.ts` implementing DEC-028's mechanical/hand-authored/fail-closed classification tiers (mirroring DEC-021's precedent): only `environment-or-infrastructure-problem` and `intermittent-flaky-behavior` are computed mechanically (run-report status / infra error-text regex; cross-run history via `runReportHistory.ts`); the other four categories require a matching `quality/failure-classifications.yaml` entry (by `testId`, optionally narrowed by `errorFingerprint`); an unmatched failure defaults, fail-closed, to `insufficient-evidence`. Built `pnpm pw:triage [--run-id <id>]` (reads an existing run report off disk, never reruns), `renderMaintenanceReportHtml.ts`, and `pnpm pw:triage:serve` (`ROOT = artifacts/playwright`, one level above both `maintenance/` and `runs/` so sibling-directory links resolve, mirroring Stage 07's `serve-suite-review.ts`). Extended `repair-write-guard.mjs` with two new independent mechanisms: (1) `assessDiffRisk`, a coarse regex-based proxy for `pw:lint-tests`'s own AST checks (assertion-count-decrease, new-fixed-wait, new-skip-only-or-fixme, new-raw-selector-in-test, page-object-or-component-change), denying an edit unless `repair-scope.json`'s new `justifiedExceptions` names that risk category with a reason; (2) a self-identified gap fix, proactive and not audit-driven — an independent re-derivation of `repairAllowed` from the actual latest on-disk `artifacts/playwright/maintenance/*.json` report, matched to the target file via its own "Test source" evidence-link path, denying the write unless that finding's `repairAllowed === true`. This gives "prohibit repair for probable application defects and insufficient-evidence outcomes" three independent enforcement layers (schema `.refine()`, `classifyFailure.ts`'s own clamping, this hook re-check) rather than resting on any single one. Extended `post-edit-validator.mjs` (`isReviewRelevant`) so any test/page-object/component/fixture/governance-yaml/scoring-evaluation-coverage change also triggers `pnpm pw:review`. Updated `.claude/skills/{pw-triage-failures,pw-repair-test,pw-author-test}/SKILL.md` and `.claude/agents/{playwright-repair,playwright-triage}.md`; bumped `FRAMEWORK_VERSION` to `"0.9.0"`. Confirmed visual-baseline-update prohibition is N/A (zero `toHaveScreenshot`/`toMatchSnapshot`/`--update-snapshots` matches repo-wide) and disclosed as such rather than silently skipped | Added 59 new/updated tests across 6 files (`classifyFailure.spec.ts` 11, `maintenanceReportHtml.spec.ts` 4 real-Chromium DOM tests, `repairWriteGuard.spec.ts` +13, `postEditValidator.spec.ts` +2, `schemas.spec.ts` +new suites, `loaders.spec.ts` +1) and fixed 2 pre-existing tests whose fixtures/assertions no longer matched new behavior (a repair-write-guard fixture whose `old_string` never actually appeared in its own fixture content; a post-edit-validator assertion string superseded by the new combined validator message). Performed a full live, end-to-end walkthrough mirroring Stage 06's precedent: wrote a temporary scratch failing test, ran it for real, triaged it for real (`pnpm pw:triage`), served the report for real (`pnpm pw:triage:serve` + `curl`/browser check — confirmed the "Test source" link resolves via a direct `curl` 200 even though the browser attempts a download rather than inline navigation for `.ts`, a pre-existing characteristic shared with Stage 07's server, not a Stage 09 regression), and confirmed a real attempted edit against a scratch `probable-application-defect` finding's named test file was denied live by the extended hook — then deleted every scratch artifact (spec file, run/maintenance reports, `repair-scope.json`) and confirmed `git status --short` clean of them before touching the ledger. `pnpm exec tsc --noEmit` clean; `pnpm pw:validate` clean (`Total: 375 tests in 36 files`); `pnpm pw:test` — **375/375 passed**, re-confirmed directly via a fresh full run rather than derived arithmetic (336 pre-existing plus the net new/updated tests above, some folded into existing spec files rather than added as separate ones) | `playwright-framework/metadata/schemas.ts`, `playwright-framework/metadata/loaders.ts`, `playwright-framework/triage/classifyFailure.ts` (new), `playwright-framework/cli/{triage,serve-maintenance-report}.ts` (new), `playwright-framework/reporting/{renderMaintenanceReportHtml.ts (new),constants.ts}`, `quality/failure-classifications.yaml` (new), `.claude/hooks/{repair-write-guard,post-edit-validator}.mjs`, `.claude/skills/{pw-triage-failures,pw-repair-test,pw-author-test}/SKILL.md`, `.claude/agents/{playwright-repair,playwright-triage}.md`, `playwright-framework/version.ts` (0.9.0), `package.json` (`pw:triage`/`pw:triage:serve` scripts), `playwright-framework/tests/{classifyFailure,maintenanceReportHtml}.spec.ts` (new), `playwright-framework/tests/hooks/{repairWriteGuard,postEditValidator}.spec.ts`, `playwright-framework/tests/{schemas,loaders}.spec.ts`, `PLAYWRIGHT_TESTING.md` (extended hook sections, new Stage 09 section), `README.md` (Layout bullet, new Stage 09 bullet), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: DEC-027, DEC-028, Stage 09 task checkboxes, this row) | Dispatch an independent, fresh-context audit subagent for Stage 09; independently re-verify its claims; on PASS, write `quality/audits/stage-09-audit.md`, check the Stage 09 Progress Dashboard box, commit, and (once BLK-001 clears) open PRs for Stages 02–09; then begin Stage 10 |
| 2026-09-11 | 09 | Independent audit (fresh context, no memory of the implementation) completed and PASSED WITH FINDINGS, then independently re-verified by the orchestrating session itself before trusting or committing anything. The audit re-derived the baseline itself (375/375, matching the implementer's claim exactly) before touching anything, then constructed a realistic multi-run history the pre-existing 375-test suite never covered — a single ancient pass followed by several genuinely consecutive recent deterministic failures — and found a real High-severity bug: `classifyFailure.ts`'s mechanical tier 2 ("intermittent/flaky") only ever required "some other run recorded a pass, at any point in history," because `classifyFailure` is only ever called on an already-failing test, making the original condition's second clause (`FAILING_STATUSES.has(test.status)`) always true by construction — collapsing the entire signal to "a pass exists somewhere, however old," and misrouting a genuine ongoing regression to `intermittent-flaky-behavior` (`repairAllowed: true`) instead of toward human review. **Fixed live**: replaced the signal with a requirement that the chronologically MOST RECENT other run on file (by `endedAt`) itself be a pass — a real recency-based oscillation check, still purely structural/mechanical, no semantic guessing. Two locking tests added to `classifyFailure.spec.ts` (the exact ancient-pass-then-ongoing-regression repro, asserting it now falls to `insufficient-evidence`/`repairAllowed: false`; a companion case confirming genuine recent-oscillation flakiness still classifies as flaky/repairable). The audit also verified, with real commands rather than code-reading alone: the three-layer `repairAllowed: false` defense (schema `.refine()` via a real zod `safeParse`; `classifyFailure.ts`'s own hand-authored-tier clamp, defeating a real adversarial `quality/failure-classifications.yaml` entry claiming `probable-application-defect`+`repairAllowed:true`; and `repair-write-guard.mjs`'s independent maintenance-report re-check) held at every layer; all 5 `assessDiffRisk` risk categories and the `justifiedExceptions` escape hatch; the maintenance-report gate's multiple-reports-by-mtime resolution and evidence-link path-mismatch handling (fails closed on case/`./`/absolute-path mismatches); `post-edit-validator.mjs`'s `isReviewRelevant` scoping in both directions (correctly triggers `pw:review` for test/page-object/component/fixture/governance-yaml/scoring-evaluation-coverage files, correctly no-ops for framework-support files and this very spec document); all 7 Section 10.4 categories present verbatim in the schema enum; and the visual-baseline-update N/A claim via the audit's own repo-wide grep (zero real matches). Two Medium findings disclosed and left open, consistent with Stage 08's own precedent: (1) `MaintenanceReportSchema` lacks `gitCommit`/`workingTreeClean` fields present on its `RunReportSchema`/`SuiteReviewSchema` siblings and required by Section 10.1 for every report; (2) the hand-authored tier clamps `repairAllowed` but not `needsHumanReview` for `probable-application-defect`/`insufficient-evidence`, so a hand-authored entry can suppress the "needs review" signal even though repair itself stays correctly blocked — a real, verified (not hypothetical) gap, though not a repair-hiding or write-scope bypass on its own. **Independently re-verified by the orchestrating session, not merely trusted**: read `classifyFailure.ts` in full and confirmed the described bug/fix match the real code exactly; personally reverted the fix in-place and re-ran the exact locking test directly, confirming it genuinely fails pre-fix (`Expected: not "intermittent-flaky-behavior"`, observed anyway) before restoring the fix from a verified-clean backup; personally re-ran the entire validation suite from scratch rather than reusing the audit's numbers; and personally inspected `schemas.ts` to directly confirm both disclosed Medium findings (the two `.optional()` fields on `MaintenanceFindingSchema`; the absent `gitCommit`/`workingTreeClean` fields on `MaintenanceReportSchema`) | Independently re-run and confirmed firsthand (not reused from the audit): `pnpm exec tsc --noEmit` clean; `pnpm pw:validate` — `Total: 377 tests in 36 files`; `pnpm pw:test` — **377/377 passed**; the pre-fix regression reproduced live by this session (temporarily reverting `classifyFailure.ts`'s tier-2 condition to its exact original form, re-running `playwright-framework/tests/classifyFailure.spec.ts` under `--project=framework-unit`, and observing the new locking test fail with the exact error the audit described), then the fix restored and the full suite re-confirmed clean; `git status --short` at the end shows only the legitimate Stage 09 implementation files (including the audit's own fix and locking tests) plus `quality/audits/stage-09-audit.md` — no scratch/probe files remain from either the audit or this session's own re-verification | `playwright-framework/triage/classifyFailure.ts` (audit's live fix: recency-based oscillation check), `playwright-framework/tests/classifyFailure.spec.ts` (2 new locking tests), `quality/audits/stage-09-audit.md` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4, Stage 09 audit gate checkboxes, Progress Dashboard, this row) | Commit Stage 09 (blocked on BLK-001 for push/PR only); begin Stage 10 — CI, documentation, adoption, and operational hardening |
| 2026-09-11 | 10 | Implemented the full Stage 10 CI/documentation/operational-hardening system. Three GitHub Actions workflows: `.github/workflows/ci.yml` (a `validate` job -- typecheck, metadata validation, lint, framework unit tests, no browser/database -- gating an `e2e` job that runs the real application suite sharded across 2 shards against a real `postgres:16` service container and a real built-and-started Next.js app, followed by a `merge-reports` job combining both shards' blob reports into one native HTML report), `scheduled-regression.yml` (nightly cron re-run, disclosed as currently duplicating the PR gate until `@suite:smoke` tests exist to differentiate them), and `weekly-quality-review.yml` (optional/best-effort per the task wording: a `--repeat-each=3` flaky re-check plus `pnpm pw:review` regeneration on a fixed weekly cadence). Added explicit CI-appropriate `timeout`/`expect.timeout`/`globalTimeout` to `playwright.config.ts` (retries/workers/forbidOnly were already CI-aware from Stage 01). Built `playwright-framework/cli/ci-summary.ts` (pure logic split into `playwright-framework/reporting/ciSummary.ts` per the `parseRunArgs.ts`/`run-tests.ts` precedent, so it's unit-testable directly) after discovering LIVE, not assumed, that `pnpm exec playwright test -g "<pattern matching nothing>"` and `--shard=N/M` with an empty shard both exit **0** -- Playwright still writes a normalized run report for either case with every count at zero, indistinguishable at a glance from a genuinely clean run. This script reads that report after every real Playwright invocation and (1) exits non-zero on a genuine zero-test run and (2) writes a `$GITHUB_STEP_SUMMARY` table plus `::warning::`/`::error::` annotations for any flaky (retry-pass), quarantined, or failed result, so none of Section 11's "cannot appear as an ordinary clean pass" cases are silently absorbed into a green check. Built `playwright-framework/cli/print-ci-selection.ts` (DEC-030) so CI's sharded invocation gets the identical test selection `pnpm pw:run --selection regression --list` would show -- reusing `evaluateExpression`/`compileToGrepPattern` directly rather than widening Stage 05's own already-audited `pw:run` (which has no `--shard` support and whose `--reporter` flag replaces the whole configured reporter array, a still-true Stage 06 finding) to accommodate CI's needs. Extended `PLAYWRIGHT_TESTING.md` with 11 new sections and created `quality/manual-test-to-automation-worksheet.md` (a real, fillable template, not just prose) and extended `README.md`'s Playwright section. Recorded DEC-029 (`next build`+`start` over `next dev` for CI), DEC-030 (the print-ci-selection.ts bypass, described above), DEC-031 (ephemeral per-run CI secrets via `openssl rand`, zero GitHub repository secrets required), and DEC-032 (disclosed, human-confirmable artifact-retention defaults: 14 days PR/nightly, 30 days weekly) | Verified every new mechanism live rather than by reading code alone: a real induced zero-test run (`ci-summary.ts` correctly exited 1); a real induced flaky test via a marker-file-based retry (module-scoped state does not survive a Playwright retry -- discovered live when a first attempt at this fixture failed for the wrong reason -- fixed by using a filesystem marker instead), correctly surfaced via `::warning::` with exit 0 preserved; real sharding (`--shard=1/2`/`--shard=2/2`, each receiving exactly one of the 2 real application tests) plus a real `playwright merge-reports` producing one combined HTML report; `print-ci-selection.ts`'s output matched `pw:run --selection regression --list`'s own preview byte-for-byte in substance (same 2 files, same compiled-pattern semantics); `pnpm pw:triage`/`pnpm pw:review` both run clean end to end (the exact commands the weekly workflow uses). All three workflow YAML files syntax-validated (`python3 -c "yaml.safe_load(...)"`, all `OK`) and schema-validated (`npx @action-validator/cli`, all exit 0) -- disclosed limitation: none has run on a real GitHub Actions runner, since BLK-001 blocks pushing to where Actions would execute; every command inside each workflow was instead verified directly, in the exact sequence/form the workflow specifies. The "clean checkout" acceptance criterion was verified via a from-scratch archive-based simulation (tar-copied the working tree excluding `node_modules`/`.git`/generated artifacts to `/tmp`, since BLK-001 blocks a real `git clone`): fresh `pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit`, `pnpm pw:validate-metadata`, `pnpm pw:lint-tests`, `pnpm pw:list` (`Total: 385 tests in 37 files`), and a real `playwright test` run of `guest-viewing.spec.ts` against the live app all succeeded from the fresh copy (one disclosed, harmless nuance: the archive has no `.git`, so `normalizedReporter.ts`'s git-info collection hit its own pre-existing, already-tested fallback rather than a real git error a genuine clone would never produce), then the scratch copy was deleted. Final full validation: `pnpm exec tsc --noEmit` clean; `pnpm pw:validate` -- `Total: 385 tests in 37 files`; `pnpm pw:test` -- **385/385 passed** (377 carried over from Stage 09 + 8 new `ciSummary.spec.ts` tests) | `.github/workflows/{ci,scheduled-regression,weekly-quality-review}.yml` (new), `playwright.config.ts` (timeout/expect.timeout/globalTimeout added), `playwright-framework/cli/{ci-summary,print-ci-selection}.ts` (new), `playwright-framework/reporting/ciSummary.ts` (new), `playwright-framework/tests/ciSummary.spec.ts` (new), `quality/manual-test-to-automation-worksheet.md` (new), `playwright-framework/version.ts` (0.10.0), `PLAYWRIGHT_TESTING.md` (11 new Stage 10 sections), `README.md` (Playwright section updated for Stage 10), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4: DEC-029 through DEC-032, Stage 10 task checkboxes, this row) | Dispatch an independent, fresh-context audit subagent for Stage 10; independently re-verify its claims; on PASS, write `quality/audits/stage-10-audit.md`, check the Stage 10 Progress Dashboard box, commit, and (once BLK-001 clears) open PRs for Stages 02–10; then begin Stage 11 — Final system audit and handoff |
| 2026-09-11 | 10 | Independent audit (fresh context, no memory of the implementation) completed and PASSED WITH FINDINGS, then independently re-verified by the orchestrating session itself before trusting or committing anything. The audit re-derived the baseline itself (`Total: 385 tests in 37 files`, matching the implementer's claim exactly) before touching anything, then rebuilt the clean-checkout simulation from scratch (tar-archive minus `node_modules`/`.git`/generated artifacts, plus the gitignored `.env` a real clone would also need) and re-ran the full validation sequence plus a real `playwright test` against the live app from that fresh copy, all succeeding. It adversarially reproduced every reachable CI scenario with real invocations rather than trusting the implementer's own prior verification: a real clean pass; a real consistent failure; a real flaky/retry-pass test using Playwright's own `retries` mechanism (`--retries=1`, matching the real e2e job's config); a real empty-shard zero-test run (`--shard=2/2` against a selection where only one file matches); and a real 2-shard split + `playwright merge-reports` producing one genuine combined HTML report. It also performed a literal documentation walkthrough as a brand-new manual tester, following `PLAYWRIGHT_TESTING.md`'s "First-test tutorial" using only its own text and the files it names to author and run a genuinely new reference-style test, which passed on the first real attempt and survived `--repeat-each=3` -- the strongest available confirmation of the one acceptance criterion ("a manual tester can author and run a reference-style test using only the documentation") Stage 10 explicitly deferred to this audit. No High-or-above finding. Three Medium findings: (1) `ci-summary.ts`'s header comment, the Stage 10 task/acceptance-criteria prose, and two `PLAYWRIGHT_TESTING.md` sections all claim a `--grep` pattern matching zero tests causes Playwright to exit `0`; reproduced directly, it actually exits `1` -- disclosed, not fixed, since `print-ci-selection.ts`'s own upstream zero-match guard means the real CI pipeline never constructs this exact invocation shape either way, so no actual gap exists. (2) `weekly-quality-review.yml`'s own comment claims its `--repeat-each=3` re-check surfaces flakiness as a `::warning::` "exactly the same way the PR gate does"; reproduced directly, with the workflow's actual `--retries=0` a real intermittent failure instead surfaces as an ordinary `::error::` failure, since Playwright's `flaky` outcome requires `retries > 0` to exist at all -- not a masked-defect risk (the job still fails loudly), disclosed and left open as a real design-narrative inaccuracy in an explicitly optional/best-effort workflow. (3) **Fixed live.** The new Stage 10 tagging cheat sheet and the manual-test-to-automation worksheet both named a tag dimension `special-purpose`, discovered by following the cheat sheet's own instruction to cross-check the real `quality/tag-taxonomy.yaml`, which calls it `test-type` (as does this guide's own older, unchanged Stage 06/07 material) -- a one-word rename in both files, zero functional risk, re-confirmed clean (`pnpm exec tsc --noEmit`, `pnpm pw:validate` -- `Total: 385 tests in 37 files`, `pnpm pw:test` -- **385/385 passed**) immediately after. **Independently re-verified by the orchestrating session, not merely trusted, and in doing so a further inaccuracy inside the audit's own report was found and corrected**: confirmed the `test-type` fix is real in both files against the actual YAML; independently re-ran `pnpm exec tsc --noEmit` and `pnpm pw:validate` directly rather than reusing the audit's numbers; independently reproduced Finding 2 with its own real scratch test (failing on exactly the 2nd of 3 `--repeat-each` iterations under real `--retries=0`, confirming `retryPass: 0` and a hard `::error::` exactly as claimed); and, while re-verifying Finding 1 specifically rather than accepting it at face value, discovered that the audit's own claim that a zero-match `--grep` invocation "writes no run report at all" is itself inaccurate -- a real all-zero-counts report (`tests: []`, `selectionSummary.matchedCount: 0`) is written every single time, reproduced three separate times including with the audit's own exact pattern string, each via an isolated before/after directory listing; feeding that report's `runId` to `ci-summary.ts` was independently re-run and correctly produced `⚠️ ZERO TESTS EXECUTED` with exit `1` via `summarizeRunReport`'s ordinary classification path, not the "no reports found" fail-closed branch (`history.reports.length === 0`) the audit credited -- that branch does exist and remains a real second line of defense, it simply isn't what fires for this scenario. Corrected in place inside `quality/audits/stage-10-audit.md` (Section 2 and Finding 1) with no change to the bottom-line verdict (Medium, disclosed, no actual CI safety gap), clearly marked as an orchestrator correction rather than silently rewritten | Independently re-run and confirmed firsthand (not reused from the audit): `pnpm exec tsc --noEmit` clean; `pnpm pw:validate` -- `Total: 385 tests in 37 files`; three separate isolated reproductions of the zero-match `--grep` scenario (including the audit's exact pattern string), each confirmed via before/after directory listings that a new all-zero-counts run report is written and each correctly classified by `ci-summary.ts` as `⚠️ ZERO TESTS EXECUTED` with exit `1`; a real scratch `--repeat-each=3 --retries=0` reproduction of Finding 2 (`1 failed, 2 passed`, `retryPass: 0`, hard `::error::`); confirmed `special-purpose` no longer appears anywhere in the repo and `test-type` is used consistently, matching `quality/tag-taxonomy.yaml`'s real dimension name; `git status --short` at the end shows only the legitimate Stage 10 implementation files (including the audit's own fix inside `PLAYWRIGHT_TESTING.md`/the worksheet, and this session's own correction inside `quality/audits/stage-10-audit.md`) plus `quality/audits/stage-10-audit.md` itself -- no scratch/probe files remain from the audit or from this session's own re-verification | `playwright-framework/reporting/ciSummary.ts` (unchanged by this audit -- reviewed, not modified), `PLAYWRIGHT_TESTING.md` (audit's live fix: `special-purpose` -> `test-type`), `quality/manual-test-to-automation-worksheet.md` (same fix), `quality/audits/stage-10-audit.md` (new; corrected in place by the orchestrating session's own re-verification), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4, Stage 10 audit gate checkboxes, Progress Dashboard, this row) | Commit Stage 10 (blocked on BLK-001 for push/PR only); begin Stage 11 — Final system audit and handoff |

---

## 5. Project Profile

Complete this section before installing or changing the framework.

| Item | Discovered value | Evidence/path |
|---|---|---|
| Repository root | `/home/claude/seatwise` (pnpm monorepo: `apps/*`, `packages/*`) | `pnpm-workspace.yaml` |
| Application type/framework | Next.js 16 (App Router) + TypeScript web app (`apps/web`); companion Expo/React Native mobile app (`apps/mobile`, out of scope for this framework) | `apps/web/package.json`, `apps/mobile/package.json` |
| Package manager and version | pnpm 10.28.0, pinned via `packageManager` field | `package.json` |
| Node version policy | No `.nvmrc`/`.node-version` committed; sandbox runs Node v22.22.2. Recorded as DEC-002 below rather than left ambiguous. | repo root (no version file found) |
| Existing Playwright version | None installed anywhere in the monorepo | no `playwright.config.*`, no `playwright` dependency in any `package.json` |
| Existing test directories | `apps/mobile/__tests__` (Vitest/Jest-style unit tests for mobile-only plan-merge/queue logic) — unrelated to browser E2E, left untouched | `apps/mobile/__tests__/*.test.ts` |
| Existing test command(s) | None at the web app level (`apps/web/package.json` scripts: `dev`, `build`, `start`, `lint` only) | `apps/web/package.json` |
| Existing CI provider | None configured (no `.github/workflows`, no other CI config found) | repo root |
| Existing lint/typecheck tools | ESLint via `apps/web/eslint.config.mjs` (flat config); TypeScript via `apps/web/tsconfig.json`, `packages/shared/tsconfig.json`, `apps/mobile/tsconfig.json` | listed paths |
| Existing `.claude` assets | None at repo root. `apps/web/CLAUDE.md` + `apps/web/AGENTS.md` exist but are Next.js's own auto-generated dev-server agent notes (regenerated by `next dev`), not Claude Code project skills/hooks — must not be confused with this framework's `.claude/` | `apps/web/CLAUDE.md`, `apps/web/AGENTS.md` |
| Primary test environment | Local dev only — `pnpm dev` on `localhost:3000` against a local Postgres instance. No staging environment exists yet. | `apps/web/.env` (`APP_URL="http://localhost:3000"`) |
| Production hostname(s) | **None — the app has never been deployed.** No Vercel/Netlify/Docker deployment config found anywhere in the repo. Until a real production host exists, "production" is undefined and the mutating-test guard (Section 7.5/9.3) must fail closed on any unrecognized/undeployed host rather than assume safety. | repo-wide search: no `vercel.json`, `netlify.toml`, `Dockerfile`; README states deployment host is "whatever this gets deployed to," not yet chosen |
| Authentication approach | Custom JWT-based session auth (`jose` for signing, `bcryptjs` for password hashing) — no third-party auth provider | `apps/web/src/lib/auth.ts`, `apps/web/package.json` dependencies |
| Test-data creation approach | Via the app's own public API: `POST /api/v1/auth/signup` to create a fresh user, then authenticated calls to create weddings/guests/tables/etc. This is exactly the pattern used by every ad hoc verification script this session (unique per-run email via timestamp). No seed/fixture DB scripts exist. | `apps/web/src/app/api/v1/auth/signup/route.ts`; prior session verification scripts |
| Supported operating systems | Dev machines only: this cloud sandbox is Linux; the human developer's machine is macOS (arm64) | environment info |
| Required browser matrix | Chromium only for now (matches spec default); Firefox/WebKit deferred as configurable-but-unused projects since the app has no known cross-browser requirements or bug history yet | DEC-003 below |
| Preferred editor/link type | Not yet specified by the human reviewer — left as a documented default (plain relative file link, no editor deep link) until stated otherwise | DEC-004 below |
| Requirements source of truth | No formal requirements doc exists. `README.md`'s "What's implemented" section is the closest thing to a living feature list. `quality/requirements.yaml` will start from that list and be expanded/corrected by the human over time — explicitly not invented wholesale by the agent. | `README.md` |
| Artifact retention requirement | Not yet specified by the human reviewer — default to spec's baseline (failure screenshots/traces always kept; success screenshots only at named checkpoints) until told otherwise | spec Section 5 defaults |
| Sensitive-data restrictions | Auth/session secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `RESEND_API_KEY`) live in untracked, gitignored `.env`/`apps/web/.env` files and must never appear in reports, logs, or committed fixtures | `apps/web/.env` (gitignored via `apps/web/.gitignore`), `.gitignore` |

### Defaults requiring confirmation or documented substitution

- TypeScript with strict type checking.
- Chromium is the required baseline browser; Firefox and WebKit are configurable projects.
- Staging or a dedicated test environment is the normal execution target.
- Production permits only separately approved read-only scenarios.
- Local diagnosis uses zero retries; CI uses one retry and labels a retry-pass as flaky.
- Failure screenshots are always retained.
- Traces are retained on failure and retry.
- Success screenshots are captured only at named business-validation checkpoints.
- Generated reports are self-contained, work offline, and use no CDN assets.
- Human approval is required before changing expected behavior or a visual baseline.

---

## 6. Target architecture

Adapt names only when the repository already has an equivalent convention. Record substitutions in the Decision Log.

```text
<repository-root>/
├── .claude/
│   ├── agents/
│   ├── hooks/
│   ├── skills/
│   └── settings.json
├── e2e/
│   ├── components/
│   ├── data/
│   ├── fixtures/
│   ├── pages/
│   ├── support/
│   └── tests/
├── quality/
│   ├── audits/
│   ├── requirements.yaml
│   ├── tag-taxonomy.yaml
│   ├── test-value-model.yaml
│   ├── test-value-model.md
│   └── value-overrides.yaml
├── playwright-framework/
│   ├── cli/
│   ├── metadata/
│   ├── reporters/
│   ├── scoring/
│   ├── templates/
│   ├── validation/
│   └── tests/
├── artifacts/
│   └── playwright/
│       ├── maintenance/
│       ├── review/
│       └── runs/
├── playwright.config.ts
└── PLAYWRIGHT_TESTING.md
```

### Architecture rules

- `quality/*.yaml` files are version-controlled sources of truth.
- `quality/test-value-model.md` is generated from `test-value-model.yaml` and must clearly say not to edit it directly.
- HTML templates and framework source are version controlled.
- Run reports, generated review reports, screenshots, traces, video, and temporary results are ignored by Git.
- Machine-readable JSON accompanies each HTML report.
- Test source files use Playwright-native tags and annotations whenever possible.
- Framework CLIs own deterministic behavior; Claude skills orchestrate those CLIs.
- No parser may discover tests through regular expressions over TypeScript source. Use Playwright discovery, its reporter APIs, and a TypeScript-aware parser where static analysis is required.

---

## 7. Functional requirements

### 7.1 Test identity and metadata

Every test shall have:

- A permanent, unique test ID.
- A concise title describing observable behavior.
- A one- or two-sentence business objective.
- At least one mapped requirement or a documented `unmapped` status.
- One or more functional tags.
- Exactly one data-impact classification: `@readonly` or `@mutating`.
- A risk classification.
- Preconditions and expected outcome.
- A description of how its assertions validate the business objective.
- A source path and starting line number supplied through discovery.
- Ownership and review metadata where the project requires it.

Metadata should use Playwright's details object, tags, and annotations so it remains visible to reporter APIs. If a typed wrapper is introduced, it must preserve ordinary Playwright behavior, editor discovery, filtering, fixtures, and stack traces.

Illustrative native metadata shape—the implementation may add typed helpers while preserving these semantics:

```ts
test('authorized user can view an order', {
  tag: ['@readonly', '@feature:orders', '@suite:smoke', '@risk:high'],
  annotation: [
    { type: 'test-id', description: 'ORD-READ-001' },
    { type: 'requirement', description: 'ORD-REQ-004' },
    { type: 'objective', description: 'Authorized users can retrieve an existing order.' },
    { type: 'expected-outcome', description: 'The selected order and its approved details are displayed.' },
    { type: 'validation', description: 'Identity and approved order fields match the seeded record.' },
  ],
}, async ({ orderPage }) => {
  // Test steps and assertions.
});
```

### 7.2 Page and component objects

- All application selectors shall be centralized in page or component objects, except selectors used exclusively by framework self-tests.
- Stable HTML IDs may be used and are assumed available for the initial implementation.
- Page objects shall expose business-readable operations rather than raw click sequences.
- Shared widgets shall use component objects rather than duplicated selectors.
- Test files should express intent and expected outcomes; they should not contain selector implementation details.
- Page objects must not conceal assertions required to understand the test. Reusable assertion helpers are allowed when their names state the business outcome clearly.
- Page/component objects must receive `Page` or `Locator` through constructors or fixtures and must not keep global browser state.

### 7.3 Test isolation and reliability

Every test shall:

- Run independently and in arbitrary order.
- Use an isolated browser context unless a documented exception is approved.
- Be safe under parallel execution.
- Create or reserve unique test data.
- Clean up created data when safe and practical.
- Avoid dependence on another test's side effects.
- Avoid fixed sleeps and arbitrary polling.
- Use Playwright web-first assertions and automatic waiting.
- Assert externally observable outcomes rather than implementation details.
- Fail when its central business validation is not executed.
- Never catch and suppress an assertion or navigation failure.
- Avoid conditional branches that allow the test to pass without validating its objective.

### 7.4 Evidence

- Failed tests must attach a failure screenshot, trace, error details, test steps, and relevant console/network diagnostics.
- Successful tests must capture screenshots only through an explicit named evidence helper after a meaningful validation checkpoint.
- Every success screenshot must be associated with a checkpoint name and validation description.
- Screenshots must supplement assertions, not replace them.
- Evidence capture must redact or avoid secrets, authentication tokens, personal data, and other configured sensitive fields.
- Artifact filenames must be collision-safe under parallel execution.

### 7.5 Reports

The implementation shall produce three distinct report families:

| Report | Trigger | Primary purpose |
|---|---|---|
| Test-run report | Every selected execution | Explain results and evidence for that run |
| Suite-review report | Explicit review command and after test changes | Evaluate inventory, value, quality, and coverage |
| Maintenance report | Explicit triage command against a failed run | Classify failures and recommend next actions |

Each report must have a self-contained HTML version and an adjacent machine-readable JSON version. Reports must be generated from version-controlled templates and must not require internet access to render.

---

## 8. High-value test model

### 8.1 Principle

Test value and test implementation quality are different concepts and must never be merged.

- **Value score:** How much confidence and risk reduction the test provides to the business, from 0 to 100.
- **Quality score:** How well the test is engineered, from 0 to 100.

A valuable but badly implemented test should retain a high value score and receive a low quality score. A polished test of a trivial cosmetic detail may have a high quality score and a low value score.

Pass/fail status, flakiness, and current implementation quality must not directly lower business value. They should instead affect the quality score and maintenance priority.

### 8.2 Canonical high-value-test list

The framework must maintain `quality/test-value-model.yaml` as the canonical, versioned list of high-value characteristics. It must include criteria, weights, scoring anchors, examples, model version, effective date, and change history. The framework shall generate `quality/test-value-model.md` and render the same criteria prominently in every suite-review report.

A highly valuable test generally has several of these characteristics:

1. Protects a revenue-producing or mission-critical workflow.
2. Protects authentication, authorization, privacy, security, or role boundaries.
3. Detects data loss, corruption, incorrect calculations, or irreversible actions.
4. Covers a workflow used frequently or by many users.
5. Covers a historically defect-prone area.
6. Exercises a boundary, failure mode, or integration likely to escape lower-level tests.
7. Validates an explicit high-priority requirement or acceptance criterion.
8. Provides unique coverage not supplied by another reliable test.
9. Represents a meaningful business outcome rather than only the existence of low-impact controls.
10. Would block or materially change a release decision if it failed.

Low-value indicators include:

1. Duplicates another test without adding a meaningful condition or risk.
2. Confirms cosmetic or implementation details with no stated business consequence.
3. Claims only a low-impact interface detail and has no meaningful business outcome.
4. Repeats behavior already covered more efficiently at a lower test level.
5. Tests unreachable or obsolete behavior.
6. Has no identifiable stakeholder, requirement, risk, or release decision attached to it.

### 8.3 Value scoring rubric: 100 points

The canonical YAML file must encode this initial model. It may be tailored through a recorded decision, but weights must total 100.

| Criterion | Weight | Scoring question |
|---|---:|---|
| Business criticality | 25 | How seriously would failure affect the organization's core operation or release decision? |
| User impact and frequency | 15 | How many users are affected, and how often is this behavior used? |
| Risk and defect likelihood | 20 | How likely and costly is a defect in this behavior, considering history and complexity? |
| Security, compliance, and data integrity | 15 | Does this protect access, privacy, regulated behavior, calculations, or durable data? |
| Unique coverage | 15 | How much important behavior would become unprotected if this test were removed? |
| Release-decision usefulness | 10 | If this intended behavior were reliably tested, would its result materially inform release or operational decisions? |

Each criterion must use explicit scoring anchors of 0, 25%, 50%, 75%, and 100% of its weight. The evaluator may use an intermediate integer only when it records evidence supporting that choice.

### 8.4 Value bands

| Score | Band | Meaning |
|---:|---|---|
| 90–100 | Critical | Essential release confidence; failure normally blocks release or demands explicit risk acceptance |
| 75–89 | High value | Strong protection of important workflows or risks |
| 50–74 | Useful | Meaningful coverage but not normally release-critical by itself |
| 25–49 | Limited | Narrow, low-impact, overlapping, or weakly justified coverage |
| 0–24 | Questionable | Little demonstrated value; improve, replace, or retire after human review |

A score of 75 or greater makes a test “high value.” A test may be designated release-critical only when the metadata identifies the responsible requirement or risk.

### 8.5 Quality scoring rubric: 100 points

| Criterion | Weight |
|---|---:|
| Independence and parallel safety | 20 |
| Assertion strength and objective traceability | 20 |
| Deterministic waiting and state control | 15 |
| Page/component object and locator design | 15 |
| Test-data setup and cleanup | 10 |
| Readability and diagnostic steps | 10 |
| Evidence and failure diagnostics | 5 |
| Metadata completeness and standards compliance | 5 |

The quality evaluator must cite concrete source evidence for deductions. It must not infer a perfect score merely because a test passed.

### 8.6 Evaluation governance

- Scoring arithmetic must be deterministic.
- AI may evaluate evidence and recommend criterion points, but must provide criterion-by-criterion rationale and confidence.
- Missing business information must be marked `NEEDS HUMAN REVIEW`; the AI must not invent impact or regulatory importance.
- Human overrides belong in `quality/value-overrides.yaml` with test ID, score or criterion override, rationale, approver, and date.
- Reports must distinguish calculated scores, human overrides, and provisional scores.
- Every score must identify the value-model version used.
- A value-model change must trigger reevaluation of every discovered test and show score changes in the next review report.
- Retiring a low-value test requires human approval; the evaluator may recommend but not delete it.

---

## 9. Tagging requirements

### 9.1 Canonical taxonomy

`quality/tag-taxonomy.yaml` shall define allowed tags, descriptions, dimensions, aliases, conflicts, required dimensions, and production eligibility.

Initial taxonomy:

| Dimension | Examples | Requirement |
|---|---|---|
| Data impact | `@readonly`, `@mutating` | Exactly one required |
| Feature | `@feature:authentication`, `@feature:orders` | At least one required |
| Suite | `@suite:smoke`, `@suite:regression` | One or more allowed |
| Risk | `@risk:critical`, `@risk:high`, `@risk:normal`, `@risk:low` | Exactly one required |
| Role | `@role:anonymous`, `@role:user`, `@role:administrator` | Optional/project-defined |
| Test type | `@visual`, `@accessibility`, `@external-service` | Optional |
| Lifecycle | `@quarantined` | Controlled and reason required |

Unknown tags must fail metadata validation. Taxonomy changes require a changelog entry.

### 9.2 Query behavior

The runner shall support:

- One tag: `@readonly`
- Logical AND: `@readonly AND @feature:orders`
- Logical OR: `@suite:smoke OR @risk:critical`
- Logical NOT: `NOT @external-service`
- Parenthesized combinations
- Named saved selections such as `smoke-readonly`
- A list-only preview showing exactly which tests would run

The CLI must translate validated expressions into Playwright-native filtering. It must escape expressions safely and must not construct a shell command through unsafe string concatenation.

### 9.3 Production safety

- Production hostnames must be explicitly configured.
- Any selection containing `@mutating` must be blocked against production.
- A production run must require an explicit production flag in addition to a production URL.
- The selection preview must display a prominent production warning.
- Approved read-only production tests should monitor unexpected state-changing network calls, with project-configured exceptions for authentication, telemetry, and known non-mutating POST operations.
- An unknown environment must default to non-production execution rules but must not be treated as approved for mutating tests until configured.

---

## 10. Report requirements

### 10.1 Shared report requirements

All reports shall:

- Be generated from version-controlled templates.
- Be self-contained and viewable offline.
- Meet basic accessibility expectations: semantic headings, keyboard operation, sufficient contrast, meaningful labels, and non-color-only status indicators.
- Include generation time, framework version, repository, Git commit, and working-tree state.
- Include searchable, sortable, and filterable tables where appropriate.
- Link related reports and artifacts by relative URL.
- Clearly label AI-generated judgment and its confidence.
- Avoid embedding secrets or sensitive data.
- Include a machine-readable JSON document validated against a versioned schema.
- Fail report generation visibly when required data is invalid; never silently omit invalid tests.

### 10.2 Test-run HTML report

The run report shall show:

- Run ID, start/end time, duration, initiator, environment, base URL, Git commit, Playwright version, Node version, operating system, browser projects, worker count, retries, and exact tag expression.
- Selection summary and tests excluded by the filter.
- Counts for initial pass, retry-pass/flaky, consistent failure, timeout, skipped, expected failure, quarantined, and setup/infrastructure failure.
- Every executed test's ID, title, source link, tags, duration, attempts, result, objective, requirements, and validation explanation.
- Named steps and assertion outcomes.
- Expected and observed result for failures.
- Error messages and sanitized stack traces.
- Success-checkpoint screenshots where captured.
- Failure screenshot, trace, console errors, failed network requests, and optional video.
- A plain-language “why this passed” summary based on successful required assertions—not merely process exit status.
- A plain-language “why this failed” summary tied to the first meaningful failure.
- Links to the native Playwright HTML report and Trace Viewer artifacts when available.

### 10.3 Suite-review and coverage HTML report

The suite-review report shall show:

- Current high-value-test criteria and model version.
- Requirements covered versus total.
- Risk-weighted coverage.
- Critical requirements without tests.
- Requirements covered only by skipped, quarantined, stale, or failing tests.
- Functional, role, suite, risk, data-impact, browser, and environment coverage.
- Duplicate or substantially overlapping tests.
- Tests with missing or invalid metadata.
- Tests not executed within the configured freshness window.
- Value and quality score distributions.
- High-value tests with poor implementation quality.
- Low-value tests consuming disproportionate execution time.
- Changes from the previous review, when a prior machine-readable report exists.
- A prioritized review queue for the human tester.

The report must itemize every discovered test and include:

1. Test ID and title.
2. Repository-relative path and starting line number.
3. Copyable path, relative file link, and optional configured editor deep link.
4. All tags and annotations.
5. Requirements and risks covered.
6. Exact short explanation of what the test does.
7. Explanation of the central business idea it validates.
8. Explanation of how its assertions validate that idea.
9. Value score, band, criterion breakdown, evidence, confidence, and model version.
10. Quality score, criterion breakdown, and concrete deductions.
11. Last known execution result and age.
12. Flake, skip, quarantine, retry, and maintenance status.
13. Recommendations requiring human review.

### 10.4 Maintenance HTML report

The maintenance report shall classify each relevant failure as one of:

- Probable application defect
- Probable test defect
- Intended application change
- Test-data problem
- Environment or infrastructure problem
- Intermittent/flaky behavior
- Insufficient evidence

For each failure it shall include:

- Test and run IDs
- Classification and confidence
- Expected versus observed behavior
- First meaningful failed step and assertion
- Relevant logs, requests, screenshots, trace, and source links
- Comparison with requirements and recent relevant code changes when available
- Evidence for and against an application defect
- Evidence for and against a test defect
- Recommended next action
- Whether automated repair is allowed
- Exact files that a proposed repair may modify
- Suggested defect description when an application bug is probable

---

## 11. Claude Code integration requirements

### 11.1 General design

Current Claude Code project skills are the preferred mechanism for reusable slash commands. Do not duplicate every skill in the legacy `.claude/commands` format. Create compatibility command files only when the installed Claude Code version requires them, and record that decision.

Skills must call deterministic repository tools for discovery, validation, execution, and report generation. Skills must not reimplement tag parsing or scoring in prose.

### 11.2 Required skills and slash workflows

Create these project skills under `.claude/skills/`:

| Skill/command | Responsibility |
|---|---|
| `/pw-bootstrap` | Resume and execute this staged specification safely |
| `/pw-author-test` | Create one or more tests from approved requirements or manual cases |
| `/pw-run-tests` | Preview a tag selection, perform safety checks, run it, and produce reports |
| `/pw-review-suite` | Discover all tests, validate metadata, score them, and generate the suite-review report |
| `/pw-triage-failures` | Analyze a selected failed run and generate a maintenance report |
| `/pw-repair-test` | Repair one explicitly identified test when permitted by triage |
| `/pw-validate-framework` | Run schemas, lint, types, unit tests, discovery checks, and framework smoke tests |

Each skill must define:

- When it should and should not be used.
- Required arguments and examples.
- Allowed scope of file changes.
- Required preflight checks.
- Deterministic commands it invokes.
- Expected output artifacts.
- Stop conditions requiring human input.
- Verification and audit steps.
- A prohibition against silently changing application behavior or expectations.

### 11.3 Recommended custom subagents

Create:

- `playwright-reviewer`: read-only evaluator for stage audits and suite quality.
- `playwright-triage`: read-only evidence analyst for failure classification.

The reviewer and triage agents must not edit tests or application code. Test repair remains an explicit, separately invoked workflow.

### 11.4 Required hooks

Use project-scoped hooks only when they provide deterministic value. Implement hook logic in portable Node scripts where feasible.

Required hook behaviors:

1. A scoped pre-tool safeguard used by `/pw-repair-test` that blocks writes outside approved test-framework paths unless the human explicitly expands scope.
2. A lightweight post-edit validator for changed Playwright test, page-object, metadata, reporter, or framework files. It may run asynchronously but must surface failures.
3. A scoped stop/stage-gate check used by `/pw-bootstrap` that prevents a stage from being declared complete without a passing audit artifact and resolved findings.

Hook requirements:

- Consume and validate Claude Code's documented JSON input.
- Return documented exit codes or structured JSON decisions.
- Use `${CLAUDE_PROJECT_DIR}` rather than assuming the current directory.
- Be covered by automated tests using representative hook input.
- Fail safely and explain blocking decisions.
- Never run the complete browser suite after every file edit.
- Never grant broader permissions than the user or repository configuration provides.
- Never place secrets in arguments, output, or log files.

---

## 12. Staged implementation plan

## Stage 00 — Repository discovery and implementation plan

### Tasks

- [ ] Confirm the repository root and inspect existing application/test structure.
- [ ] Record package manager, Node policy, Playwright state, CI, lint, TypeScript, and Claude Code assets.
- [ ] Identify existing user changes and files that must not be overwritten.
- [ ] Identify test environments and explicitly list production hostnames.
- [ ] Identify authentication, test accounts, secrets, data creation, and cleanup mechanisms.
- [ ] Identify or create a plan for the requirements source of truth.
- [ ] Determine required browser projects and supported operating systems.
- [ ] Determine report artifact retention and editor-link behavior.
- [ ] Complete Section 5 and record every deviation from default architecture.
- [ ] Produce `quality/audits/stage-00-audit.md` containing discovery evidence, risks, and the proposed file plan.

### Acceptance criteria

- No framework dependency has been installed before discovery is complete.
- The Project Profile contains no unexplained `TBD` entries needed by Stage 01.
- Production targets and mutating-test policy are unambiguous.
- Existing Playwright or test assets have an explicit reuse/migration plan.

### Stage 00 audit gate

- [ ] Audit repository observations against actual files and commands.
- [ ] Verify the plan does not overwrite or duplicate compatible infrastructure.
- [ ] Verify production and credential risks are documented.
- [ ] Resolve audit findings.
- [ ] Mark the audit `PASS` and update the Progress Dashboard.

## Stage 01 — Playwright foundation and environment safety

### Tasks

- [ ] Install or align Playwright Test using the existing package manager and lockfile.
- [ ] Pin compatible Node and Playwright versions according to repository policy.
- [ ] Create or adapt strict TypeScript configuration for the test framework.
- [ ] Create or adapt `playwright.config.ts` with environment-driven base URL, output paths, projects, workers, retries, timeouts, and artifact options.
- [ ] Implement typed environment configuration and schema validation.
- [ ] Implement explicit production-host recognition and fail-closed mutating-test protection.
- [ ] Create the target directory structure without overwriting user files.
- [ ] Configure Git ignores for generated artifacts and secrets.
- [ ] Add baseline package commands for install, list, test, headed, debug, UI, report, and framework validation.
- [ ] Add a minimal framework health test that does not depend on the application.
- [ ] Document exact installation and browser-install commands.

### Acceptance criteria

- Playwright can list and run the framework health test.
- Type checking passes.
- Invalid environment configuration fails with an actionable message.
- A simulated mutating production selection is blocked before browser launch.
- Generated artifacts do not appear as tracked files.

### Stage 01 audit gate

- [ ] Inspect version pinning, lockfile changes, paths, timeouts, retries, and environment handling.
- [ ] Test environment guards with production, staging, missing, and malformed inputs.
- [ ] Verify no secrets or absolute developer-specific paths were committed.
- [ ] Resolve audit findings and rerun validation.
- [ ] Write a passing `quality/audits/stage-01-audit.md` and update the Progress Dashboard.

## Stage 02 — Test governance, metadata, tags, and value model

### Tasks

- [x] Create versioned schemas for requirements, tag taxonomy, value model, overrides, test inventory, run results, and maintenance results.
- [x] Create an initial `quality/requirements.yaml` template with examples clearly marked as non-application placeholders.
- [x] Create `quality/tag-taxonomy.yaml` with required dimensions, conflicts, aliases, and descriptions.
- [x] Create `quality/test-value-model.yaml` implementing Section 8.
- [x] Generate `quality/test-value-model.md` from the canonical YAML.
- [x] Create `quality/value-overrides.yaml` with validation and approval fields.
- [x] Implement native tag/annotation helpers or a thin typed metadata wrapper.
- [x] Implement metadata validation for unique IDs, required mappings, tag rules, objectives, and expected outcomes.
- [x] Implement deterministic value and quality arithmetic.
- [x] Implement a structured interface for AI evidence judgments, confidence, and human-review flags.
- [x] Add unit tests covering score boundaries, bands, missing information, overrides, and model-version changes.

### Acceptance criteria

- Invalid or contradictory metadata fails before execution.
- Score weights total 100 and boundary tests pass.
- Reports can distinguish calculated, provisional, and human-overridden scores.
- The human-readable criteria list is reproducibly generated from the canonical file.
- No score depends on pass/fail status alone.

### Stage 02 audit gate

- [x] Review every criterion for ambiguity, double counting, and separation of value from quality.
- [x] Verify unknown information produces human review rather than fabricated evidence.
- [x] Test all schema failures and override rules.
- [x] Resolve findings and rerun unit tests. (Medium finding — unreachable `ScoreSource: "provisional"` — closed post-audit; 72/72 tests passing.)
- [x] Write a passing `quality/audits/stage-02-audit.md` and update the Progress Dashboard.

## Stage 03 — Page objects, fixtures, test data, and evidence architecture

### Tasks

- [x] Implement the base page-object pattern and at least one reusable component-object example.
- [x] Centralize application selectors; use stable IDs where provided.
- [x] Implement typed fixtures for page objects and shared components.
- [x] Implement authentication-state fixtures without embedding credentials.
- [x] Implement unique test-data naming and worker-safe identity helpers.
- [x] Implement project-specific data setup/cleanup interfaces with explicit no-op or unsupported states.
- [x] Implement a named success-evidence helper that attaches screenshot and validation description.
- [x] Implement failure diagnostics for screenshots, console errors, failed requests, and traces.
- [x] Implement configurable redaction/sanitization before report rendering.
- [x] Ensure artifact paths are unique across projects, workers, retries, and test IDs.

### Acceptance criteria

- A test can request page objects, data helpers, and evidence through typed fixtures.
- Parallel executions do not collide on data or artifact filenames.
- Credentials and configured sensitive values are absent from captured artifacts.
- Page objects do not store global mutable browser state.

### Stage 03 audit gate

- [x] Review page/component boundaries and selector centralization.
- [x] Exercise fixtures under parallel and retry conditions.
- [x] Attempt redaction with representative sensitive values.
- [x] Verify cleanup errors are reported without hiding the original test failure.
- [x] Resolve findings, write a passing `quality/audits/stage-03-audit.md`, and update the Progress Dashboard.

## Stage 04 — Test-authoring standards, enforcement, and reference tests

### Tasks

- [x] Write `PLAYWRIGHT_TESTING.md` with authoring, debugging, metadata, tagging, evidence, and review guidance.
- [x] Define naming and directory conventions.
- [x] Define Arrange/Act/Assert and named `test.step` expectations.
- [x] Require observable assertions and prohibit screenshot-only validation.
- [x] Add lint/static rules for raw selectors outside approved abstractions.
- [x] Add checks for fixed waits, `test.only`, unreasoned skip/fixme/fail, swallowed errors, and missing assertions.
- [x] Add checks for unknown tags, duplicate IDs, missing mappings, and stale metadata.
- [x] Add a documented exception mechanism requiring rationale and review.
- [x] Create a high-quality read-only reference test against a safe project behavior.
- [x] Create a high-quality mutating reference test with isolated setup and cleanup when the project permits it.
- [x] Create examples of intentionally bad patterns used only by framework validation tests.
- [x] Add repeated and parallel runs that test independence of the reference tests.

### Acceptance criteria

- A manual tester can follow the guide to understand and modify a reference test.
- Bad-pattern fixtures are detected by automated validation.
- Reference tests pass individually, in reverse selection order, in parallel, and through configured repeat execution.
- Test source reads primarily as business intent rather than selector mechanics.

### Stage 04 audit gate

- [x] Review reference tests against every rule in Sections 7 and 8.
- [x] Verify enforcement catches each prohibited example without false positives on reference tests.
- [x] Have the reviewer explain each reference test's objective without reading its page-object implementation first.
- [x] Resolve findings, write a passing `quality/audits/stage-04-audit.md`, and update the Progress Dashboard.

## Stage 05 — Tag-expression runner and safe execution workflow

### Tasks

- [x] Implement a cross-platform TypeScript CLI for tag selection.
- [x] Implement AND, OR, NOT, parentheses, and saved named selections.
- [x] Validate all tags against the taxonomy before invoking Playwright.
- [x] Add a list-only preview mode that shows selected test IDs, titles, tags, and data impact.
- [x] Detect contradictory expressions and empty selections with actionable messages.
- [x] Translate validated expressions into Playwright-native filtering without unsafe shell interpolation.
- [x] Invoke the Playwright CLI as the authoritative execution engine and forward only explicitly supported, validated options.
- [x] Implement environment and production preflight checks.
- [x] Add explicit confirmation requirements for allowed production read-only execution.
- [x] Capture the normalized expression and exact execution configuration in the run manifest.
- [x] Add package commands for common selections such as read-only, smoke, regression, and critical.
- [x] Add parser and selection unit tests, including quoting and injection attempts.

### Acceptance criteria

- AND, OR, NOT, parentheses, and saved selections return expected test inventories.
- Preview and actual execution select the same tests.
- Unknown tags and shell-like malicious input are rejected safely.
- Mutating production tests cannot start.
- A zero-test selection is visible and is not represented as a successful test run.

### Stage 05 audit gate

- [x] Compare runner selection with direct Playwright discovery across a representative query matrix.
- [x] Test production guards and adversarial tag input.
- [x] Verify friendly error messages for a non-developer user.
- [x] Resolve findings, write a passing `quality/audits/stage-05-audit.md`, and update the Progress Dashboard.

## Stage 06 — Test-run reporting and diagnostic artifacts

### Tasks

- [x] Configure Playwright's native HTML reporter as a diagnostic companion.
- [x] Implement a custom reporter that writes normalized run-result JSON.
- [x] Create the self-contained run-report HTML template.
- [x] Render run metadata, selection, status counts, attempts, steps, assertions, and source links.
- [x] Render plain-language pass and failure explanations from structured evidence.
- [x] Attach success-checkpoint and failure screenshots.
- [x] Link traces, console/network diagnostics, native report, and optional video.
- [x] Distinguish initial pass, retry-pass/flaky, consistent failure, timeout, skip, expected failure, quarantine, and infrastructure failure.
- [x] Implement sanitized stack traces and artifact path handling.
- [x] Implement a local report-serving command and optional editor deep links (deep links remain off per DEC-004; the serving command is `pnpm pw:report:run`).
- [x] Validate JSON against its schema before rendering HTML.
- [x] Add snapshot or DOM-level tests for all major report states.

### Acceptance criteria

- Representative pass, assertion failure, timeout, retry-pass, skip, and setup failure render correctly.
- Every failed test has actionable evidence or a visible explanation of missing evidence.
- Every claimed successful validation is backed by an executed assertion.
- The report works offline and contains no absolute path unless configured for local editor linking.
- Report generation errors cause a nonzero result without erasing raw Playwright output.

### Stage 06 audit gate

- [x] Review the report as a manual tester, developer, and release decision-maker.
- [x] Validate accessibility, filtering, links, artifact retention, and sensitive-data handling.
- [x] Compare displayed counts with machine JSON and Playwright's native result.
- [x] Resolve findings, write a passing `quality/audits/stage-06-audit.md`, and update the Progress Dashboard.

## Stage 07 — Suite review, coverage analysis, and test catalog

### Tasks

- [x] Implement complete test discovery using Playwright and TypeScript-aware static analysis where needed. (Reuses Stage 06's `discoverAllApplicationTests` — same AST-based walk `pw:lint-tests`/the reporter already use, so discovery can never drift between the three.)
- [x] Implement requirement-to-test and risk-to-test mapping. (`computeRequirementCoverage`'s `coveringTestIds` per requirement; risk mapping via each covering test's own `@risk:*` tag, used by both risk-weighted coverage and the review queue.)
- [x] Calculate requirement, risk-weighted, tag, data-impact, role, and freshness coverage. ("Browser" coverage is generically supported by `computeDimensionCoverage` operating over whatever dimensions `quality/tag-taxonomy.yaml` defines, but the taxonomy has no browser/environment dimension yet — consistent with DEC-003's Chromium-only, no-cross-browser-matrix decision; nothing to report is not a gap in this stage's mechanism, and one line of taxonomy config would make it appear with zero code changes.)
- [x] Detect uncovered requirements and requirements covered only by unhealthy tests. (`computeRequirementCoverage`'s `coveredOnlyByUnhealthyTests`, distinct from "uncovered" — verified against the real suite: 17/18 requirements uncovered, 1/18 covered and healthy.)
- [x] Detect likely duplicates and label them as recommendations, not automatic deletions. (`detectDuplicates.ts`; the real `guest-viewing`/`guest-management` pair proven NOT flagged — different data-impact tags — both in a unit test and in the real generated report.)
- [x] Evaluate every test against the versioned value and quality rubrics. (`evaluateTest.ts` + `computeScore`/`applyOverride`; criterion IDs/weights cross-checked 1:1 against `quality/test-value-model.yaml`.)
- [x] Mark uncertain judgments for human review with confidence and missing information. (Every `CriterionJudgment` carries `confidence`/`needsHumanReview`/a specific rationale naming exactly what's missing.)
- [x] Implement previous-report comparison and score/model change tracking. (`diffSuiteReviews.ts` + `findMostRecentSuiteReviewPath`, verified live across three successive real `pnpm pw:review` runs; a `quality/test-evaluations.yaml`/model-version mismatch prints an explicit warning.)
- [x] Create the self-contained suite-review HTML template. (`renderSuiteReviewHtml.ts`, same self-contained/offline/accessible posture as Stage 06's run-report renderer — no external assets, real DOM-tested.)
- [x] Include the full current high-value criteria list in the report. (Model version shown at the document and per-score level; every criterion's label/weight/points/rationale appears in every test's expandable breakdown.)
- [x] Itemize every discovered test with all fields required by Section 10.3. (All 13 fields — see the Stage 07 section of `PLAYWRIGHT_TESTING.md` for the field-by-field mapping.)
- [x] Implement repository-relative links, line numbers, copyable paths, and optional editor links. (Repo-relative `<a href>` + a separate `<code>` copyable path:line; no editor deep link, consistent with DEC-004 — still no configured editor.)
- [x] Add filters for value, quality, feature, risk, result, freshness, quarantine, and review status. (Search text, value-band select, quality-band select, feature select, risk select, result select, stale-or-never-executed checkbox, quarantined-only checkbox, needs-human-review-only checkbox — all real `<input>`/`<select>` elements, each with its own DOM test.)
- [x] Generate a prioritized human-review queue. (`buildReviewQueue.ts` — additive, documented point values, only tests with a concrete reason appear at all.)
- [x] Add automated report fixture tests for complete, missing, invalid, duplicate, and provisional metadata. (`computeCoverage.spec.ts` — placeholder/retired exclusion; `detectDuplicates.spec.ts` — true/false positives; `evaluateTest.spec.ts` — hand-authored-present/missing branches; `suiteReviewHtml.spec.ts` — provisional/quarantined/empty-suite fixtures, plus the real generated report.)

### Acceptance criteria

- Playwright's discovered test count exactly matches the report catalog after documented project expansion rules. — Verified live: `discoverAllApplicationTests` found 2 tests, `review.tests.length === 2`, both by construction (`suiteReviewTests` is a 1:1 `.map()` over `discovered`) and by a real DOM assertion (`suiteReviewHtml.spec.ts`'s `.test-row` count against the real generated JSON).
- No invalid test disappears silently. — `parseErrorCount` is carried through to the report and surfaced in the HTML meta table with an explicit warning when nonzero (0 in the real suite today).
- Coverage percentages state their denominator and exclusions. — `CoverageBucket.denominatorLabel` (requirement coverage: "18 requirement(s) ... (2 placeholder/retired excluded)") and `.weightingRule` (risk-weighted coverage's exact weighting rule spelled out) on every bucket.
- Every score shows its breakdown, evidence, confidence, and model version. — Per-criterion table (label, points/weight, confidence, rationale) plus the score's own `modelVersion` displayed in its heading.
- A criteria-model change predictably reevaluates all tests. — The 9 mechanical criteria are recomputed fresh on every invocation regardless of model version (no caching); the 2 hand-authored criteria are checked against the live model version and flagged with an explicit warning when `quality/test-evaluations.yaml` was authored against an older one.
- Human overrides are preserved and clearly identified. — `applyOverride` never mutates the calculated result; verified live with a temporary real override (`criterion-score` on `unique-coverage`, reverted before commit) — the JSON showed `source: "override"`, the recomputed total, and a populated `overrideRef`, and the HTML rendered the "Human override" callout with the rationale/approver/date.

### Stage 07 audit gate

- [x] Manually trace a sample of high-, medium-, and low-value scores back to source evidence.
- [x] Challenge duplicate, coverage, and risk-weighted calculations with controlled fixtures.
- [x] Verify every test has a working source reference and appears exactly once per intended Playwright project representation.
- [x] Verify the report never presents unsupported AI judgment as fact.
- [x] Resolve findings, write a passing `quality/audits/stage-07-audit.md`, and update the Progress Dashboard.

## Stage 08 — Claude Code skills, commands, subagents, and hooks

### Tasks

- [x] Implement every skill in Section 11.2 as a project skill with focused instructions. (All 7:
  `.claude/skills/{pw-bootstrap,pw-author-test,pw-run-tests,pw-review-suite,pw-triage-failures,
  pw-repair-test,pw-validate-framework}/SKILL.md`.)
- [x] Ensure slash invocations accept documented arguments and show concise help. (Each `SKILL.md`
  declares `argument-hint` and states its required arguments in its own "Required arguments"
  section; `/pw-repair-test` additionally sets `disable-model-invocation: true` so only a human can
  invoke it.)
- [x] Ensure each skill delegates deterministic work to the framework CLIs. (Every skill's "commands
  this skill invokes" section names the real `pnpm pw:*` CLI; none reimplement tag parsing, linting,
  or scoring in prose.)
- [x] Implement read-only reviewer and triage subagents with minimal necessary tools.
  (`playwright-reviewer`, `playwright-triage`: `tools: Read, Grep, Glob, Bash` only, plus a
  subagent-scoped `PreToolUse` hook denying Write/Edit/NotebookEdit as defense in depth.)
- [x] Implement the scoped repair write guard. (`.claude/hooks/repair-write-guard.mjs`, wired only
  into `playwright-repair`'s frontmatter — see DEC-024/DEC-025 for the design and why it's split
  into a committed outer directory allowlist plus an ephemeral per-session scope file.)
- [x] Implement the lightweight post-edit validator. (`.claude/hooks/post-edit-validator.mjs`,
  project-wide `PostToolUse`, runs only `tsc --noEmit`/`pw:lint-tests`/`pw:validate-metadata`
  depending on what changed — never a browser-backed test project.)
- [x] Implement the scoped bootstrap stage-gate/stop check. (`.claude/hooks/stage-gate-check.mjs`,
  project-wide `PreToolUse` scoped internally to edits of `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` —
  see DEC-026 for the `Result: PASS` convention it depends on.)
- [x] Use current documented Claude Code hook JSON and exit behavior. (Fetched
  `code.claude.com/docs/en/{hooks,skills,sub-agents}` directly before writing any hook —
  `hookSpecificOutput.permissionDecision`, exit 0/2/other semantics, `${CLAUDE_PROJECT_DIR}`,
  subagent-frontmatter-scoped `hooks:`, and skill frontmatter fields like
  `disable-model-invocation`/`context: fork`/`argument-hint` all verified live against that
  documentation, not assumed from training data.)
- [x] Add automated tests for allowed, denied, malformed, and missing hook inputs.
  (`playwright-framework/tests/hooks/{repairWriteGuard,stageGateCheck,postEditValidator,
  readonlyBashGuard}.spec.ts` — 44 tests total, each script covering its own allowed/denied-or-
  surfaces-failure/malformed-stdin/missing-field cases, run as real spawned `node` child processes.)
- [x] Test all skills from a fresh Claude Code session or closest available noninteractive harness.
  (No interactive Claude Code CLI is available inside this sandboxed session to drive `/pw-*`
  end-to-end; the closest available harness is exactly what was used — real subagent invocations via
  the `Agent`/`Task` tool against the real, on-disk `.claude/agents/*.md` frontmatter, and real
  spawned-process tests of every hook script the skills rely on. See the Stage 08 audit for the live
  subagent-level verification this performed.)
- [x] Document how skills, hooks, and optional compatibility commands are installed and invoked.
  (`PLAYWRIGHT_TESTING.md`'s new "Claude Code integration (Stage 08)" section.)
- [x] Document behavior when Claude Code features or versions are unavailable. (Same section, "When
  Claude Code features are unavailable" — no legacy `.claude/commands/` layer exists, per Section
  11.1, because no version used during this build required one; every workflow still works as a
  plain `pnpm pw:*` command with no skills/hooks layer at all.)

### Acceptance criteria

- Each skill can be invoked independently and produces its documented artifact or stop condition. —
  verified per-skill against the real underlying CLI commands (see Implementation Log).
- Reviewer and triage agents cannot edit files. — enforced by omitting Write/Edit/NotebookEdit from
  their `tools:` list, and independently by `readonly-bash-guard.mjs` denying those tools outright
  plus blocking mutating Bash commands.
- Repair cannot write application source or unrelated files without an explicit human-approved scope
  change. — enforced mechanically by `repair-write-guard.mjs`'s two-layer check (DEC-025), not just
  documented.
- Hooks do not recursively invoke Claude, leak secrets, or launch expensive full-suite runs on
  ordinary edits. — no hook here ever invokes Claude itself (`type: command` only, no `type: prompt`/
  `agent`); no hook logs or echoes secrets (none of the four scripts read or print environment
  variables beyond `CLAUDE_PROJECT_DIR`); `post-edit-validator.mjs` never runs a browser-backed
  Playwright project, only `tsc --noEmit`/`pw:lint-tests`/`pw:validate-metadata`.
- Stage completion is blocked when the audit artifact is missing or failing. — enforced mechanically
  by `stage-gate-check.mjs`, live-tested against exactly this condition (see its own unit tests and
  the Stage 08 audit).

### Stage 08 audit gate

- [x] Review skill scopes, allowed tools, arguments, failure paths, and stopping rules.
- [x] Attempt unauthorized writes through the repair workflow and verify they are blocked.
- [x] Test hook behavior from main and subagent contexts where applicable.
- [x] Verify current Claude Code documentation rather than relying on stale syntax.
- [x] Resolve findings, write a passing `quality/audits/stage-08-audit.md`, and update the Progress Dashboard.

## Stage 09 — Failure triage and controlled test repair

### Tasks

- [x] Implement maintenance-report JSON schema and HTML template. `MaintenanceFindingSchema`/`MaintenanceReportSchema` (DEC-027) in `playwright-framework/metadata/schemas.ts`; `renderMaintenanceReportHtml.ts` renders a self-contained HTML report (status conveyed by symbol+text, collapsible `<details>` evidence per finding, light/dark via `prefers-color-scheme`). Verified with 4 real-Chromium DOM tests (`maintenanceReportHtml.spec.ts`) plus a live `pnpm pw:triage:serve` + `curl`/browser check.
- [x] Implement artifact collection by run ID without rerunning first. `pnpm pw:triage [--run-id <id>]` (`playwright-framework/cli/triage.ts`) reads an existing `artifacts/playwright/runs/run-reports/<runId>.json` (or the most recent one) off disk; it never invokes `playwright test`/`pw:run` itself. Verified live: triaged an already-completed run by explicit ID with no test execution occurring (confirmed via `ps`/no new run report timestamp).
- [x] Implement classification categories from Section 10.4. All 7 categories implemented in `classifyFailure.ts` per DEC-028's mechanical/hand-authored/fail-closed split; unit-tested for every category in `classifyFailure.spec.ts` (11 tests).
- [x] Require evidence-for, evidence-against, confidence, and missing-information fields. All 12 Section 10.4 fields are non-optional on `MaintenanceFindingSchema` (schema-enforced, not just convention); `classifyFailure.ts` populates every field for every finding, including an honest empty/low-confidence shape when evidence is thin.
- [x] Compare failure evidence with requirements, test intent, metadata, and relevant code history when available. `classifyFailure.ts` reads the target test's governed metadata (objective/expectedOutcome/requirementIds) and cross-run history (`runReportHistory.ts`) to populate `comparisonWithRequirements`/expected-vs-observed; the `playwright-triage` subagent (read-only) supplements with human-facing narrative from the run report's own console/network/trace evidence, never overriding the mechanical result.
- [x] Prohibit repair for probable application defects and insufficient-evidence outcomes. Enforced three independent ways (not just one): (1) `MaintenanceFindingSchema`'s own `.refine()` forces `repairAllowed: false` whenever `classification` is `probable-application-defect` or `insufficient-evidence`; (2) `classifyFailure.ts`'s hand-authored-tier clamping applies the same rule before a finding is ever constructed; (3) `repair-write-guard.mjs` independently re-reads the latest on-disk maintenance report and denies the write if the matched finding's own `repairAllowed` is not `true` -- a defense-in-depth chain proactively added (not audit-driven) because a single enforcement point would leave the acceptance criterion resting on trust rather than mechanism. Live-verified: a scratch `probable-application-defect` finding produced a real hook denial on an attempted edit to its named test file.
- [x] Require explicit test ID and maintenance recommendation for `/pw-repair-test`. `.claude/skills/pw-repair-test/SKILL.md`'s preflight requires the target `testId` and the matching maintenance finding's `recommendedNextAction`/`repairAllowed` before any edit is attempted; the hook-level maintenance-report gate above makes this non-optional rather than only a documented courtesy.
- [x] Require intended behavior or human approval before changing an expected result. Unchanged from the skill's existing Stage-08-era stop condition (never silently redefine what "correct" means); Stage 09 additionally requires the triage classification itself (`probable-test-defect`/`test-data-problem`/`intended-application-change` with `repairAllowed: true`) before that conversation can even begin.
- [x] When functionality expands, determine whether to add focused validation to the existing test or create a separate independent test; do not overload one test with unrelated outcomes. Added as its own decision-guidance section in `.claude/skills/pw-author-test/SKILL.md` ("Extending an existing test vs. authoring a new one (Stage 09)"), with the two concrete decision rules and the rationale for never overloading one test with unrelated outcomes.
- [x] Constrain repair to the smallest justified change. `repair-write-guard.mjs`'s new `assessDiffRisk` (assertion-count-decrease, new-fixed-wait, new-skip-only-or-fixme, new-raw-selector-in-test, page-object-or-component-change) denies a repair edit outright unless `repair-scope.json`'s `justifiedExceptions` names that specific risk category with a reason -- a coarse regex proxy for the same checks `pw:lint-tests`/`checkTestSource` apply to authored tests, disclosed as coarser than a real AST parse. 13 new locking tests in `repairWriteGuard.spec.ts` cover every risk category and the exception escape hatch.
- [x] Prohibit automatic visual-baseline updates. Confirmed N/A rather than silently skipped: `grep -rn` for `toHaveScreenshot`/`toMatchSnapshot`/`--update-snapshots` across the entire repo returns zero matches -- this framework has no visual-regression/snapshot testing at all, so there is no baseline-update mechanism to prohibit. Disclosed explicitly here and in `PLAYWRIGHT_TESTING.md` rather than marking the box checked with no explanation.
- [x] Show the proposed or completed diff and explain preservation of the original objective. Existing `.claude/skills/pw-repair-test/SKILL.md` diff-and-explain step carried forward unchanged; Stage 09 adds the mechanical diff-risk gate above so an unjustified diff is blocked before it can be shown as "completed."
- [x] Rerun the repaired test repeatedly and then run related tests. Unchanged from the existing skill's post-edit verification step (`pnpm pw:run` with `--repeat-each`, then the same file's/page-object's other covering tests); Stage 09's new `post-edit-validator.mjs` addition (below) adds an automatic, non-negotiable suite-review regeneration alongside it.
- [x] Regenerate the suite-review report after any test, page object, fixture, metadata, or scoring change. `post-edit-validator.mjs` extended with `isReviewRelevant` -- any edit to a test/page-object/component/fixture/governance-yaml/scoring-evaluation-coverage file now also triggers `pnpm pw:review` (lightweight, non-browser) alongside the existing `pw:validate-metadata`/`pw:lint-tests` checks. 2 new locking tests in `postEditValidator.spec.ts`; live-verified against the real repo (editing a real page object triggered a real `pw:review` regeneration).
- [x] Preserve original failure artifacts and link the before/after results. The maintenance report's `evidenceLinks` point at the ORIGINAL failing run's own artifacts (screenshots/trace/run-report path) rather than copying or mutating them; a repaired test's subsequent passing run produces its own separate run report under its own `runId`, so before/after are two distinct, both-preserved artifacts a human can open side by side -- verified live in the end-to-end scratch-failure walkthrough (induced failure's run report and maintenance report both remained on disk, untouched, after the repair-and-rerun step).

### Acceptance criteria

- Controlled fixtures produce the correct classification for application, test, data, infrastructure, flaky, and unknown failures. Verified by `classifyFailure.spec.ts`'s 11 unit tests (one or more per Section 10.4 category, including a hand-authored-tier match, an unmatched fail-closed `insufficient-evidence`, and both mechanical categories) plus a live induced real failure classified end-to-end.
- A probable application bug remains visible and is not "fixed" by changing the test. Enforced by the three-layer `repairAllowed: false` chain described above; a real attempted edit against a scratch `probable-application-defect` finding was denied live by the hook, not just asserted in a unit test.
- Repair cannot broaden selectors, remove assertions, add sleeps, or skip a test without explicit justified review. Enforced by `assessDiffRisk` plus the pre-existing Stage 08 scope/symlink checks; every risk category has a locking unit test proving both the denial and the `justifiedExceptions` escape hatch.
- A repaired test passes repeated and related execution while preserving its objective. Unchanged workflow step from Stage 08, still required by the skill; not newly mechanically enforced this stage (tracked as relying on the human-in-the-loop workflow, consistent with how repair execution itself has always worked).
- Maintenance and review reports show a complete audit trail. The maintenance report schema requires run/test IDs, evidence links, and a recommended next action for every finding; `renderMaintenanceReportHtml.ts` surfaces all of it; original artifacts are never overwritten (previous task).

### Stage 09 audit gate

- [x] Run adversarial scenarios designed to tempt the repair workflow to hide a defect. Found and fixed live (High): mechanical tier 2's "intermittent/flaky" signal collapsed to "a pass exists somewhere in history, however old" because `classifyFailure` is only ever called on an already-failing test, making the old condition's second clause always-true by construction — a genuine, ongoing, deterministic regression with one ancient pass could be misclassified as flaky-and-repairable. Fixed by requiring the most recent OTHER run on file to itself be a pass (real recency-based oscillation signal). Independently re-verified by the orchestrating session: read the fix, reverted it temporarily, confirmed the new locking test genuinely fails pre-fix (`Expected: not "intermittent-flaky-behavior"`, got it anyway), restored the fix, and confirmed 377/377 clean again.
- [x] Review classification confidence and ambiguous-evidence handling. Confirmed each `confidence` value traces to a real, distinct signal (not a blanket constant); confirmed the fail-closed `insufficient-evidence` default via a real triage run with both evidence-for/against arrays genuinely empty rather than fabricated.
- [x] Verify repair write scope and human-approval requirements. All 5 `assessDiffRisk` categories and the `justifiedExceptions` escape hatch tested directly and held; the maintenance-report `repairAllowed` re-check tested against multiple-report-by-mtime and evidence-link path-mismatch edge cases, all failing closed. No bypass found.
- [x] Verify suite review automatically follows test modification. `isReviewRelevant` tested directly against real repo files in both directions (triggers for test/page-object/component/fixture/governance-yaml/scoring-evaluation-coverage files, correctly no-ops for framework-support files and this very spec document) — matches the claimed scope exactly.
- [x] Resolve findings, write a passing `quality/audits/stage-09-audit.md`, and update the Progress Dashboard. `quality/audits/stage-09-audit.md` written, first line `Result: PASS WITH FINDINGS`. Two Medium findings left open and independently confirmed real by the orchestrating session via direct schema inspection: (1) `MaintenanceReportSchema` has no `gitCommit`/`workingTreeClean` fields, unlike `RunReportSchema`/`SuiteReviewSchema` and Section 10.1's blanket requirement; (2) the hand-authored tier clamps `repairAllowed` but not `needsHumanReview` for `probable-application-defect`/`insufficient-evidence` (confirmed at `classifyFailure.ts`'s hand-authored-tier branch: `needsHumanReview: override.needsHumanReview` is not forced the way `repairAllowed` is on the line above it). Neither is a repair-hiding or write-scope-bypass risk; both tracked as open follow-up work, not blocking.

## Stage 10 — CI, documentation, adoption, and operational hardening

### Tasks

- [x] Integrate metadata validation, lint, typecheck, and framework unit tests into CI. `.github/workflows/ci.yml`'s `validate` job runs `pnpm exec tsc --noEmit`, `pnpm pw:validate-metadata`, `pnpm pw:lint-tests`, and `pnpm exec playwright test --project=framework-unit` (no browser/database needed) before the `e2e` job is even allowed to start (`needs: validate`).
- [x] Add an appropriate browser-test CI workflow using project conventions. The `e2e` job runs the real application suite (`e2e/tests/**`) against a real `postgres:16` service container and a real built-and-started Next.js app (DEC-029), using this framework's own established tag-selection conventions (the "regression" saved selection, same as a human would run locally via `pnpm pw:run:regression`) rather than inventing a CI-only selection.
- [x] Configure retries, workers, sharding, and timeouts appropriate to CI resources. `playwright.config.ts` already had CI-aware `retries`/`workers`/`forbidOnly`; this stage added explicit `timeout`/`expect.timeout`/`globalTimeout` (CI-only, disclosed rationale in the config's own comment) and 2-shard support (DEC-030), verified live end-to-end: two real shards each received exactly one of the 2 real application tests, both passed, and `playwright merge-reports` genuinely combined both shards' blob reports into one HTML report.
- [x] Upload run, trace, screenshot, and report artifacts with documented retention. Every workflow uploads via `actions/upload-artifact` with an explicit `retention-days` (DEC-032: 14 days PR-gate/nightly, 30 days weekly quality review) covering blob reports (for merging), the normalized run-report JSON/traces/screenshots (`artifacts/playwright/runs/{run-reports,test-results}`), and (weekly) suite-review/maintenance reports.
- [x] Ensure CI secrets are scoped and never printed. `DATABASE_URL` points at an ephemeral, job-lifetime-only service container (never a secret); `JWT_SECRET`/`ENCRYPTION_KEY` are generated fresh per run via `openssl rand -hex 32`, written to `$GITHUB_ENV`, never echoed to any log (DEC-031) -- the baseline CI gate requires zero configured GitHub repository secrets, confirmed by reading every workflow file for any `${{ secrets. }}` reference (none exist).
- [x] Add branch/PR status behavior for failed, flaky, quarantined, and zero-test runs. A real, verified gap drove this: `pnpm exec playwright test -g "<pattern matching nothing>"` and `--shard=N/M` with an empty shard both exit **0** (confirmed live, not assumed), and Playwright still writes a normalized run report -- all-zero counts, `tests: []` -- indistinguishable at a glance from a report worth calling a clean pass. `playwright-framework/cli/ci-summary.ts` (new, with its pure logic in `playwright-framework/reporting/ciSummary.ts`, 8 unit tests) reads that report after every real Playwright invocation in all three workflows and (1) exits non-zero on a genuine zero-test run -- the one case it overrides Playwright's own exit code for -- and (2) writes a `$GITHUB_STEP_SUMMARY` table plus a `::warning::`/`::error::` annotation for any flaky (retry-pass), quarantined, or failed result, so none of those can look like an ordinary clean pass on the PR checks list. Verified live for all four cases: a real clean pass, a real zero-test run (script correctly exited 1), a real induced flaky test (retry-pass correctly warned, exit 0 preserved), and real failures (correctly counted and annotated).
- [x] Add scheduled regression and optional stale/flaky review jobs. `.github/workflows/scheduled-regression.yml` (nightly cron) re-runs the same regression selection independent of push/PR activity, disclosed as currently duplicating the PR gate's own coverage until `@suite:smoke`-tagged tests exist to make the two gates' scope genuinely different. `.github/workflows/weekly-quality-review.yml` (weekly cron, explicitly optional/best-effort per the task wording) re-runs the regression selection with `--repeat-each=3` to proactively surface newly-flaky tests (verified live: 6/6 passed cleanly against the current suite, confirming no existing flakiness) and regenerates the suite review (`pnpm pw:review`, verified live) on a fixed cadence.
- [x] Complete `PLAYWRIGHT_TESTING.md` for a manual tester. Extended with 11 new Stage 10 sections (first-test tutorial, tagging cheat sheet, common commands, report-review guide, good/bad examples, manual-test-to-automation worksheet pointer, adding requirements/tags/page-objects/fixtures/test-data, updating the value model, report retention/cleanup, CI/sharding/report-merging, framework upgrade/compatibility) alongside the pre-existing Stage 04-09 material.
- [x] Add a first-test tutorial, tagging cheat sheet, common commands, debugging guide, and report-review guide. First-test tutorial: a 10-step walkthrough from picking a requirement to running `pnpm pw:validate`. Tagging cheat sheet: every dimension/tag from `quality/tag-taxonomy.yaml` in one table, plus the four real saved selections. Common commands: every `pnpm pw:*` script (and the two new Stage 10 CLIs) in one consolidated table. Debugging guide: already existed from Stage 04 (kept, not duplicated). Report-review guide: what each of the three report families (run/suite-review/maintenance) answers and when to open which.
- [x] Add good/bad examples and a manual-test-to-automation worksheet. A 6-row good/bad table directly mirrors `pw:lint-tests`'s own real rules (raw selector, fixed wait, unreasoned skip, swallowed error, one-test-many-outcomes, shared mutable state) so each example ties to a real, enforced check rather than a stylistic opinion. `quality/manual-test-to-automation-worksheet.md` is a real, fillable template file (not just prose) mapping directly onto `defineQualityTest`'s metadata + Arrange/Act/Assert shape.
- [x] Document adding requirements, features, tags, page objects, fixtures, and test data. One bullet per artifact type, each naming the exact file to edit and the validation command to run afterward.
- [x] Document updating the value model and approving overrides. Covers `quality/test-value-model.yaml`'s 100-point-weight constraint and `pnpm pw:generate-value-model-md`'s drift-detection relationship, and `quality/value-overrides.yaml`'s required fields (`overrideType`, `criterionId` when applicable, `approver`, `date`, `rationale`) and its "never silently erases the calculated result" guarantee (`applyOverride.ts`, unchanged from Stage 02).
- [x] Document report retention, cleanup, and disk-usage expectations. Local: everything under `artifacts/playwright/` is gitignored and safe to delete wholesale at any time (nothing outside it depends on old report content). CI: ties directly to DEC-032's disclosed retention-day defaults per workflow.
- [x] Document framework upgrade and compatibility checks. A 5-step sequence (read the changelog for reporter/tag/sharding-relevant changes; bump and re-run the FULL validation sequence; re-verify the CI-specific mechanisms live -- zero-test exit code, sharded blob-report merging; bump `FRAMEWORK_VERSION` only once everything is green; update this guide/README in the same change) rather than a vague "test it after upgrading."

### Acceptance criteria

- A clean checkout can install, validate, list, and run the documented baseline workflow. Verified live via a real from-scratch simulation (BLK-001 blocks an actual `git clone`, so the working tree was archived to a fresh directory excluding `node_modules`/`.git`/generated artifacts, mirroring how prior stages substituted the next-most-rigorous available method when a tool wasn't available): a fresh `pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit`, `pnpm pw:validate-metadata`, `pnpm pw:lint-tests`, `pnpm pw:list` (`Total: 385 tests in 37 files`), and a real `playwright test` invocation of `guest-viewing.spec.ts` against the live app all succeeded from the fresh copy. Disclosed nuance: the archive-based copy has no `.git` directory, so `normalizedReporter.ts`'s git-info collection printed (harmless, already-caught) `fatal: not a git repository` warnings to stderr and fell back to its existing `"unknown"`/clean-by-default handling -- a real `git clone` (what this simulation stands in for) would not hit this at all.
- CI publishes usable reports even when tests fail. Every workflow's report-upload steps use `if: always()`, confirmed by reading each workflow file; a real induced failure/flaky test during this stage's own verification produced a real normalized run report and native HTML report exactly as it would in CI.
- A manual tester can author and run a reference-style test using only the documentation. Addressed by the new first-test tutorial's step-by-step structure; final confirmation is the Stage 10 audit gate's own "documentation walkthrough from the perspective of a new manual tester," not self-assessed here.
- Flaky or zero-test runs cannot appear as an ordinary clean pass. `ci-summary.ts`, verified live for both cases (see the corresponding task annotation above) -- this is the one acceptance criterion this stage did the most real, adversarial-style verification against, since it directly contradicts an assumption ("Playwright's exit code tells you whether the run was healthy") that turned out to be false for 2 of its own 4 clauses.
- No secrets or sensitive artifacts are exposed in CI output. Confirmed by reading all three workflow files end to end: no `${{ secrets. }}` reference exists anywhere; the two generated values are written to `$GITHUB_ENV` (which GitHub Actions never echoes back to a log) and never appear in a `run:` command's own printed output.

### Stage 10 audit gate

- [x] Exercise the clean-checkout setup and documented commands. Independent audit rebuilt the clean-checkout simulation from scratch (tar-archive minus `node_modules`/`.git`/generated artifacts, plus the gitignored `.env` a real clone would also need) and re-ran `pnpm install --frozen-lockfile`, typecheck, `pw:validate-metadata`, `pw:lint-tests`, `pw:list`, and a real `playwright test` against the live app, all clean and matching the implementer's own numbers exactly. Independently re-verified by the orchestrating session via a separate full `pnpm exec tsc --noEmit`/`pnpm pw:validate` re-run (`Total: 385 tests in 37 files`) against the real (non-archived) working tree.
- [x] Review CI behavior for pass, failure, retry-pass, cancellation, and report-generation failure. Real induced cases for every reachable scenario: a real clean pass, a real consistent failure, a real flaky/retry-pass test (via `testInfo.retry` + `--retries=1`, matching the real e2e job's config), a real empty-shard zero-test run, and a real 2-shard split + `merge-reports`. Cancellation and mid-run reporter-crash were reviewed statically (BLK-001 blocks a real GitHub Actions run), disclosed as such rather than claimed as live-verified. Found and disclosed two Medium findings in the process (documentation/design-narrative claims that don't match real Playwright behavior, though the underlying CI safety property holds either way — see audit-gate item 4 below). The orchestrating session independently re-reproduced both zero-test scenarios and the flaky/`--repeat-each` scenario itself (not merely re-reading the audit's report) and, in doing so, found and corrected one inaccuracy inside the audit's own write-up (see item 4).
- [x] Conduct a documentation walkthrough from the perspective of a new manual tester. Independent audit literally followed `PLAYWRIGHT_TESTING.md`'s "First-test tutorial" using only the tutorial's own text and the files it names, authored a genuinely new reference-style test end to end, and passed on the first real attempt (survived `--repeat-each=3` too) — the strongest available confirmation of this criterion, which Stage 10's own acceptance-criteria text explicitly deferred to this audit gate rather than self-assessing. Surfaced one real, first-timer-facing documentation defect this way (Finding 3 below).
- [x] Resolve findings, write a passing `quality/audits/stage-10-audit.md`, and update the Progress Dashboard. `quality/audits/stage-10-audit.md` written, first line `Result: PASS WITH FINDINGS`. No High-or-above finding. Three Medium findings: (1) `ci-summary.ts`'s header comment/task/acceptance-criteria prose/`PLAYWRIGHT_TESTING.md` all claim a zero-match `--grep` exits Playwright with code `0`; it actually exits `1` — disclosed, not fixed (no functional risk: `print-ci-selection.ts`'s own upstream zero-match guard means the real CI pipeline never constructs this exact invocation shape either way). The audit's own further claim that this same invocation "writes no run report at all" was independently re-verified by the orchestrating session and found to be itself inaccurate — a real all-zero-counts report **is** written every time (reproduced three separate times, including with the audit's own exact pattern string) and `ci-summary.ts` correctly classifies it as a zero-test run via its ordinary report-reading path, not the "no reports found" fail-closed branch the audit credited; corrected in place in the audit document by the orchestrating session, with no change to the bottom-line verdict. (2) `weekly-quality-review.yml`'s comment claims its `--repeat-each=3` re-check surfaces flakiness as a `::warning::`, "exactly the same way the PR gate does" — with the workflow's actual `--retries=0`, Playwright's `flaky` outcome can never fire for a `--repeat-each` iteration, so a real intermittent failure instead surfaces as an ordinary `::error::` failure; not a masked-defect risk (the job still fails loudly), disclosed and left open since fixing the underlying intent is a real design change to a workflow this stage's own task list marks explicitly optional/best-effort. Independently reproduced by the orchestrating session with a real scratch test failing on exactly its 2nd of 3 repeat-each iterations under the real `--retries=0` shape: `retryPass: 0`, a hard `::error::`, confirming the finding exactly. (3) The new Stage 10 tagging cheat sheet and the manual-test-to-automation worksheet both named a tag dimension `special-purpose`; the real `quality/tag-taxonomy.yaml` (and this guide's own older, unchanged material) calls it `test-type` — fixed live (one-word rename in both files, zero functional risk, re-confirmed clean by both the audit and, independently, by the orchestrating session directly grepping both files against the real YAML). Progress Dashboard box below checked.

## Stage 11 — Final system audit and handoff

### Tasks

- [ ] Run the complete framework validation command.
- [ ] Run metadata, schema, lint, and type checks.
- [ ] Run framework unit, integration, hook, report, and safety tests.
- [ ] Run reference Playwright tests individually, repeatedly, in parallel, and by tag combinations.
- [ ] Generate representative run, suite-review, and maintenance reports.
- [ ] Verify production safeguards through simulation without touching production.
- [ ] Verify source links and report artifacts from a clean checkout path.
- [ ] Verify all stages have passing audit artifacts and resolved findings.
- [ ] Review Git diff for unintended application or user-file changes.
- [ ] Record known limitations, deferred items, and upgrade considerations.
- [ ] Create `quality/audits/final-audit.md` with commands, results, evidence, and overall verdict.
- [ ] Complete the handoff checklist below.

### Acceptance criteria

- All required stages pass.
- All deterministic validators and framework tests pass.
- The three report families satisfy their schemas and human-review requirements.
- Every discovered test is cataloged or visibly invalid; none is silently omitted.
- Tag selection is correct and production safety is enforced.
- The high-value model is versioned, visible, reproducible, and used for every value evaluation.
- Claude skills and hooks are tested, narrowly scoped, and documented.
- A human can resume implementation or maintenance using repository files alone.

### Stage 11 audit gate

- [ ] Perform an independent adversarial audit of the entire framework.
- [ ] Correct all critical and high findings.
- [ ] Obtain human disposition for any accepted medium or low finding.
- [ ] Mark `quality/audits/final-audit.md` as `PASS`.
- [ ] Mark Stage 11 and the overall specification complete.

---

## 13. Test-authoring definition of done

A new or modified Playwright test is complete only when:

- [ ] Its permanent test ID is unique.
- [ ] Its objective and expected result are explicit.
- [ ] It maps to a requirement or is visibly marked for human mapping.
- [ ] Its tags are valid and include exactly one data-impact tag.
- [ ] Its selectors are centralized.
- [ ] Its data is independent and parallel-safe.
- [ ] Its steps read as a business workflow.
- [ ] Its meaningful outcomes use web-first assertions.
- [ ] It cannot pass without executing its central validation.
- [ ] It uses no fixed sleeps or swallowed errors.
- [ ] Its success evidence is limited to meaningful named checkpoints.
- [ ] It produces useful failure evidence.
- [ ] It passes individually and under the configured repeated/parallel check.
- [ ] Related tests pass.
- [ ] Its value and quality evaluation is generated and reviewed when required.
- [ ] The suite-review report has been regenerated.

---

## 14. Failure-triage decision rules

Use these rules in order:

1. Confirm the intended behavior from a requirement or human-provided acceptance criterion.
2. Confirm the target environment and test-data preconditions.
3. Inspect the first meaningful failure, not only the last cascading error.
4. Inspect trace, screenshot, console, network, retry, and recent-change evidence.
5. Reproduce narrowly when safe; do not begin by editing the test.
6. Classify with confidence and list counter-evidence.
7. If the application violates confirmed intent, report an application defect and preserve the failing test.
8. If the test violates confirmed intent or framework standards, recommend a bounded repair.
9. If intended behavior changed, require the updated requirement or explicit human confirmation.
10. If evidence is insufficient, request information rather than guessing.

The following are never sufficient reasons by themselves to change a test:

- The test failed after an application change.
- A different selector makes the test pass.
- A retry passed.
- The current UI “looks reasonable.”
- A screenshot differs.
- Removing an assertion makes the suite green.

---

## 15. Required command surface

Exact command names may adapt to repository conventions, but equivalent behavior is required.

```text
<package-manager> pw:install
<package-manager> pw:list
<package-manager> pw:test
<package-manager> pw:test:headed
<package-manager> pw:test:debug
<package-manager> pw:test:ui
<package-manager> pw:select -- --tags '<expression>' --list
<package-manager> pw:select -- --tags '<expression>' --run
<package-manager> pw:review
<package-manager> pw:triage -- --run-id '<id>'
<package-manager> pw:report -- --run-id '<id>'
<package-manager> pw:serve-report -- --run-id '<id>'
<package-manager> pw:validate
```

Commands must work without Claude Code. Skills provide guided agentic workflows on top of these deterministic commands.

---

## 16. Audit artifact template

Every stage audit file must use this structure:

```markdown
# Stage NN Audit

Result: PASS | FAIL | BLOCKED
Auditor: <agent/subagent/human>
Date/time: <ISO timestamp>
Git commit or working-tree identifier: <value>

## Scope
## Files reviewed
## Commands executed and results
## Acceptance criteria evidence
## Findings
### Critical
### High
### Medium
### Low
## Corrections made
## Remaining risks and human decisions
## Final verdict
```

An audit with unresolved critical/high findings cannot pass. An audit with unresolved medium/low findings can pass only when each is explicitly accepted by the human and recorded in the Decision Log.

---

## 17. Handoff checklist

- [ ] Installation succeeds from a clean checkout.
- [ ] Configuration and environment examples contain no real secrets.
- [ ] Production safety rules are documented and tested.
- [ ] Reference tests demonstrate read-only and mutating patterns where applicable.
- [ ] Tag filtering supports AND, OR, NOT, preview, and saved selections.
- [ ] Native and templated test-run reports work.
- [ ] Suite-review report catalogs every test and displays the value criteria.
- [ ] Every test receives separate value and quality evaluations.
- [ ] Maintenance report and classification workflow work.
- [ ] Repair workflow is bounded, audited, and cannot hide probable product defects.
- [ ] Claude Code skills, subagents, and hooks work from a fresh session.
- [ ] Manual-tester documentation has been walked through.
- [ ] CI retains reports on success and failure according to policy.
- [ ] Final audit passes.
- [ ] Known limitations and deferred improvements are documented.

---

## 18. Non-goals and prohibited shortcuts

This implementation shall not:

- Attempt to generate an exhaustive application test suite during framework bootstrap.
- Replace unit, component, contract, accessibility, performance, or security testing with browser tests.
- Calculate “coverage” merely as number of passing tests divided by total tests.
- Treat a screenshot as proof without an assertion.
- Use self-healing selectors that silently change test behavior during a run.
- Automatically update snapshots or expected values after a failure.
- Hide flakiness through retries.
- Delete tests based solely on an AI value score.
- Modify application code during test triage or repair without a separate explicit request.
- Run mutating tests against production.
- Store real credentials in the repository.
- Depend on Claude Code for deterministic commands that should work in CI and a normal terminal.
- Use deprecated Claude Code command structures when supported project skills provide the current mechanism.

---

## 19. Compatibility and authoritative references

Before implementation, verify syntax against the currently installed versions and current official documentation. Record any compatibility decision.

- Playwright best practices: https://playwright.dev/docs/best-practices
- Playwright page-object models: https://playwright.dev/docs/pom
- Playwright fixtures: https://playwright.dev/docs/test-fixtures
- Playwright tags and annotations: https://playwright.dev/docs/test-annotations
- Playwright reporters: https://playwright.dev/docs/test-reporters
- Playwright configuration and recording: https://playwright.dev/docs/test-use-options
- Playwright Trace Viewer: https://playwright.dev/docs/trace-viewer
- Claude Code skills: https://code.claude.com/docs/en/skills
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents

---

## 20. Final instruction to Claude Code

Begin with Stage 00. Maintain this file as the source of implementation state. Do not skip a stage audit. Do not proceed past a failing gate. Prefer small, verifiable changes. When a requirement is ambiguous in a way that could change application behavior, production safety, report truthfulness, or test intent, stop and ask the human. Otherwise, make the safest reasonable repository-consistent choice, record it, implement it, verify it, audit it, and continue.
