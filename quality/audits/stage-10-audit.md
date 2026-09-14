Result: PASS WITH FINDINGS

Auditor: Independent review subagent, fresh context with no memory of the implementation work,
instructed to treat the code and documentation as unseen and to run real commands rather than trust
the implementation log's prose.
Date/time: 2026-09-11
Repository is a git repo (working tree, no commits made by this audit).

## Scope

Verify Stage 10 (CI, documentation, adoption, and operational hardening) against
`PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`'s Stage 10 task list, acceptance criteria, and audit gate; the
three new GitHub Actions workflows under `.github/workflows/`; `playwright-framework/cli/ci-summary.ts`
and its pure logic in `playwright-framework/reporting/ciSummary.ts`;
`playwright-framework/cli/print-ci-selection.ts`; the CI-only `timeout`/`expect.timeout`/
`globalTimeout` addition to `playwright.config.ts`; `PLAYWRIGHT_TESTING.md`'s 11 new Stage 10
sections; `quality/manual-test-to-automation-worksheet.md`; the README's Playwright section; and
DEC-029 through DEC-032. BLK-001 (no GitHub remote/PAT access) is a disclosed, accepted blocker —
no real GitHub Actions run was or could be exercised; every workflow claim was instead verified by
running the exact same commands each workflow step runs, directly, in this sandbox, plus a static
read of the YAML for anything genuinely un-reproducible (cancellation, reporter-crash mid-run). The
live app (`pnpm dev`, confirmed via `curl` returning `200` on `http://localhost:3000`) and its
Postgres 16 cluster (`pg_lsclusters` showed `main` online on 5432) were both already running.
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` was exported for every real Playwright invocation and never
written to any committed file. Every file named in the audit brief was read in full before any
command was run.

## Files reviewed

- `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`'s Stage 10 task list/acceptance criteria/audit gate, DEC-029
  through DEC-032, and the Stage 10 Implementation Log row.
- `.github/workflows/{ci,scheduled-regression,weekly-quality-review}.yml`, in full.
- `playwright-framework/cli/ci-summary.ts`, `playwright-framework/reporting/ciSummary.ts`,
  `playwright-framework/tests/ciSummary.spec.ts` (in full).
- `playwright-framework/cli/print-ci-selection.ts`, in full.
- `playwright.config.ts` (the Stage 10 diff, plus the surrounding `reporter`/`projects` config it
  interacts with).
- `PLAYWRIGHT_TESTING.md`, all 11 new Stage 10 sections plus the pre-existing "Walking through a
  reference test" section the tutorial depends on.
- `quality/manual-test-to-automation-worksheet.md`, in full.
- `README.md`'s diff.
- `playwright-framework/version.ts` (`FRAMEWORK_VERSION` bump).
- `quality/tag-taxonomy.yaml`, `quality/requirements.yaml`, `e2e/fixtures/index.ts`,
  `e2e/pages/WeddingGuestsPage.ts`, `e2e/components/GuestRow.ts`, `e2e/tests/guest-viewing.spec.ts`,
  `e2e/tests/guest-management.spec.ts` — all read as part of actually following the first-test
  tutorial as a new manual tester would, not just to confirm the tutorial's prose.
- `playwright-framework/reporting/normalizedReporter.ts` (the `classifyOutcome`/counts logic
  specifically, to understand exactly how `retryPass` vs. `consistentFailure` gets attributed).
- `.gitignore` (to confirm `.env` and `artifacts/playwright/` are correctly excluded from a real
  clone, informing how the clean-checkout simulation was built).

## Verification commands run (numbers I personally observed, not taken from the log)

- `pnpm exec tsc --noEmit` — clean before, during, and after this audit's own documentation fix.
- `pnpm pw:validate-metadata` — `Metadata OK: 20 requirements, 7 tag dimensions (33 tags), value
  model 1.0.0 (6 value + 8 quality criteria), 0 overrides` (unchanged before/after this audit's fix,
  since the fix only touches prose in two Markdown files).
- `pnpm pw:lint-tests` — `Lint OK: 3 test file(s), 2 discovered test(s), 0 hard failures` (4 files
  while my own scratch reference test existed; back to 3 after cleanup).
- `pnpm pw:list` / `pnpm pw:validate` — `Total: 385 tests in 37 files`, matching the implementer's
  claim exactly, both before and after this audit's fix.
- `pnpm pw:test` — **385/385 passed** (54.9s), matching the implementer's claim exactly, re-run
  clean after this audit's own documentation fix.
- A full from-scratch clean-checkout simulation: the working tree tar-archived (excluding
  `node_modules`, `.git`, `artifacts/playwright/{runs,maintenance}`) to a fresh scratchpad directory,
  then `pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit`, `pnpm pw:validate-metadata`,
  `pnpm pw:lint-tests`, `pnpm pw:list`, and a real `pnpm exec playwright test --project=chromium
  e2e/tests/guest-viewing.spec.ts` run against the live app, all from the fresh copy — then deleted.
- A real, direct reproduction of a `--grep` pattern matching zero tests against real, named spec
  files (not a hypothetical): `pnpm exec playwright test --project=chromium --grep
  "this-matches-absolutely-nothing-xyz123" e2e/tests/guest-viewing.spec.ts` and a second attempt
  using an actual compiled tag-lookahead pattern for a nonexistent tag — both real invocations, run
  directly, output captured to files and inspected byte-for-byte.
- A real, direct reproduction of an empty `--shard`: `pnpm exec playwright test --project=chromium
  --grep "@readonly" e2e/tests/guest-management.spec.ts e2e/tests/guest-viewing.spec.ts --shard=2/2`,
  with the resulting run report read directly (not summarized from memory) and then fed to
  `pnpm exec tsx playwright-framework/cli/ci-summary.ts --run-id <that exact run>`.
- A real, direct reproduction of a genuine flaky/retry-pass test using Playwright's own `retries`
  mechanism (`testInfo.retry`), run with `--retries=1` (matching the real e2e job's config-level
  `retries: env.CI ? 1 : 0`), and a real, direct reproduction of an ordinary consistent failure with
  `--retries=1` — both fed through `ci-summary.ts` and inspected.
- A real, direct reproduction of the exact `--repeat-each=3 --retries=0` invocation shape
  `weekly-quality-review.yml` uses, against a scratch test that fails on exactly one of three
  invocations (tracked via a filesystem marker, since module-scoped JS state does not survive a
  repeat-each iteration — each is an independent test case) — run for real, fed through
  `ci-summary.ts`, and the resulting classification inspected directly.
- A real, direct 2-shard split-and-merge of the real `regression` selection: `--shard=1/2` and
  `--shard=2/2` each invoked for real with `--reporter=blob,<normalizedReporter path>`, each
  confirmed to receive exactly one of the two real application tests, then `playwright
  merge-reports --reporter=html` run for real against both shards' blob reports, producing a genuine
  merged `index.html`.
- A literal, step-by-step attempt at PLAYWRIGHT_TESTING.md's "First-test tutorial" section, writing
  and running one new reference-style test using only what the tutorial and the files it explicitly
  points to say (`e2e/tests/guest-viewing.spec.ts`, `quality/requirements.yaml`,
  `e2e/pages/WeddingGuestsPage.ts`, `e2e/components/GuestRow.ts`) — not this auditor's own prior
  Playwright knowledge.
- `python3 -c "yaml.safe_load(...)"` against all three workflow files (`OK` for each) and
  `grep -rn "secrets\."` against them (zero matches).
- `git status --short` at the end — only the legitimate Stage 10 implementation files (now including
  this audit's fix inside `PLAYWRIGHT_TESTING.md` and `quality/manual-test-to-automation-worksheet.md`,
  both already part of this stage's tracked/untracked deliverables) plus this report; no scratch/probe
  files remain (see "Cleanup" at the end).

## 1. Clean-checkout simulation, re-run myself rather than trusted from the log

BLK-001 blocks a real `git clone`, so — mirroring the exact substitute the implementer used, itself
mirroring prior stages' own precedent for a missing tool — I tar-archived the working tree
(excluding `node_modules/`, `.git/`, and `artifacts/playwright/{runs,maintenance}`) to a fresh
directory under this session's own scratchpad, and additionally copied the real, gitignored `.env`
into it (confirmed via `.gitignore` that `.env` is never committed, so a real clone would need this
same manual step — copying from `.env.example` or an existing `.env` — before any of these commands
would work at all; this is not a hidden dependency, just one worth naming explicitly since a bare
`git clone` alone would not produce a runnable checkout either).

From that fresh copy: `pnpm install --frozen-lockfile` succeeded (946 packages, lockfile already up
to date); `pnpm exec tsc --noEmit` was clean; `pnpm pw:validate-metadata` reported the identical
`20 requirements, 7 tag dimensions (33 tags)`; `pnpm pw:lint-tests` reported the identical
`3 test file(s), 2 discovered test(s), 0 hard failures`; `pnpm pw:list` reported the identical
`Total: 385 tests in 37 files`; and a real `pnpm exec playwright test --project=chromium
e2e/tests/guest-viewing.spec.ts` against the live app passed. All five commands printed the disclosed,
harmless `fatal: not a git repository` warning from `normalizedReporter.ts`'s git-info collection
(there is no `.git` in a tar-archived copy) and fell back to its already-tested `"unknown"`/
clean-by-default handling exactly as the implementer's own log describes — a real `git clone` would
never hit this path at all. The scratch copy and its tar archive were deleted immediately afterward.
This acceptance criterion holds, independently re-verified rather than trusted.

## 2. CI status-gating mechanism (`ci-summary.ts`): the real, reachable scenarios all hold

I treated the implementer's central, most-repeated claim — "`playwright test` exits 0 for both a
zero-match `--grep` and an empty `--shard`" — as exactly the kind of assumption this framework's own
stated ethos says to verify rather than trust, and tested both halves independently, adversarially,
against Playwright 1.63.0 as actually installed here.

**The `--shard` half of the claim is exactly right, re-verified from scratch.** A real invocation —
`--grep "@readonly" e2e/tests/guest-management.spec.ts e2e/tests/guest-viewing.spec.ts --shard=2/2`
(only one of the two files contains a test matching `@readonly`, so shard 2 receives zero) — exited
`0`, printed nothing alarming, and wrote a genuine run report with `selectionSummary: {matchedCount:
0, excludedCount: 2}` and every count at zero, `tests: []`. Feeding that exact report to
`pnpm exec tsx playwright-framework/cli/ci-summary.ts --run-id <id>` correctly produced the
`⚠️ ZERO TESTS EXECUTED` markdown block, the `::error::` annotation, and exit code `1`. This is the
scenario CI's own `e2e` job can actually encounter (a shard's slice of a real, non-empty selection
happens to be empty), and it is caught correctly, end to end, exactly as documented.

**The `--grep`-matches-nothing half of the claim is partially inaccurate as stated, though the
underlying safety property still holds — corrected below by the orchestrating session's own
independent re-verification (see "Orchestrator correction" at the end of this section).** The
audit subagent ran the implementer's own example command shape directly —
`pnpm exec playwright test --project=chromium --grep "this-matches-absolutely-nothing-xyz123"
e2e/tests/guest-viewing.spec.ts` — twice, once with an arbitrary literal string and once with an
actual compiled tag-lookahead-style pattern for a nonexistent tag (`^(?=.*@suite:nonexistent...)`),
both against real, existing spec files. Both **exited 1**, printed `Error: No tests found.` to
stdout — correctly contradicting `ci-summary.ts`'s own header comment and the Stage 10
task/acceptance-criteria prose, which claim exit code **0** for this case. That part of the
correction is confirmed accurate.

**Orchestrator correction (independent re-verification, not merely trusted from the audit
subagent's report):** the audit subagent's further claim that this invocation "wrote no run report
at all" does **not** hold up. Re-running the exact same command in isolation (a single before/after
directory listing of `artifacts/playwright/runs/run-reports/*.json` around one invocation, repeated
twice more for confirmation, including with the audit's own exact pattern string
`"this-matches-absolutely-nothing-xyz123"`) shows a new run-report JSON file **is** written every
time, with `tests: []`, every `counts` field at `0`, and `selectionSummary: {matchedCount: 0,
excludedCount: 2}` — exactly the "all-zero-counts" report the original documentation described, just
paired with exit code `1` rather than `0`. Feeding that exact report's `runId` to `pnpm exec tsx
playwright-framework/cli/ci-summary.ts --run-id <id>` was also independently re-run and correctly
produced the `⚠️ ZERO TESTS EXECUTED` markdown block, the `::error::` annotation, and exit code `1` —
via `summarizeRunReport`'s ordinary report-classification path, not via the `history.reports.length
=== 0` fail-closed branch the audit subagent's write-up credited. That fail-closed branch does exist
in `ci-summary.ts` (confirmed by reading it) and remains a real second line of defense for a
genuinely report-less CI step, but it is not what actually fires for a zero-match `--grep` — a report
is written and correctly classified through the normal path instead.

This does **not** translate into an actual CI gap, and it's worth being precise about why the
distinction still doesn't matter in practice: the real CI pipeline never constructs a `--grep`/
file-list combination where the pattern matches nothing in the given files, because
`print-ci-selection.ts` — which computes both the pattern and the file list before `playwright test`
is ever invoked — already refuses (its own `process.exit(1)`, confirmed by reading its code) to print
an invocation for a selection matching zero tests. The only way a CI-real invocation can end up with
zero *executed* tests is the sharding case, which is real, reachable, and correctly handled as shown
above. And even in the directly-constructed zero-`--grep` scenario (unreachable through the real
pipeline, but reproduced here for thoroughness), the exit code alone (`1`) already fails the CI step
before `ci-summary.ts` is even reached, and `ci-summary.ts` independently reaches the same correct
verdict when run afterward regardless. So the practical safety property this stage's acceptance
criterion cares about ("flaky or zero-test runs cannot appear as an ordinary clean pass") holds for
every scenario the real workflows can actually produce, confirmed through the *actual* mechanism this
time — but the documentation and code comments still overclaim exit code `0` for a scenario that is
both unreachable through the real pipeline and, when constructed directly, exits `1`, not `0`.
Recorded as Finding 1 below (Medium, disclosed; description corrected by the orchestrating session).

**Real flaky/retry-pass and real consistent-failure scenarios, using Playwright's own `retries`
mechanism (the real e2e job's actual config, not a hypothetical)**, both behaved exactly as
documented. A scratch test using `testInfo.retry` to fail once then pass, run with `--retries=1`
(matching `playwright.config.ts`'s `retries: env.CI ? 1 : 0`), produced Playwright's own `1 flaky`
summary, exit code `0`, and `ci-summary.ts` correctly reported `Flaky (retry-pass): 1` with a
`::warning::` annotation and the "not an ordinary clean pass" markdown line. A second scratch test
that fails deterministically, run the same way, produced exit code `1` and `ci-summary.ts` correctly
reported `Failed: 1` with an `::error::` annotation. Both were verified against real Playwright
output, not synthetic `RunReport` fixtures (the unit tests in `ciSummary.spec.ts` — 8 of them,
recounted directly — already cover the fixture-level logic; this was the missing live confirmation).

## 3. Real 2-shard split and merge

Re-ran the actual sharding mechanism from scratch rather than trusting the implementer's own prior
verification: `print-ci-selection.ts regression` printed the same compiled pattern and the same two
files (`guest-management.spec.ts`, `guest-viewing.spec.ts`) it always has; `--shard=1/2` and
`--shard=2/2`, each with `--reporter=blob,./playwright-framework/reporting/normalizedReporter.ts`,
each genuinely ran exactly one of the two tests; `playwright merge-reports --reporter=html
./all-blob-reports` genuinely extracted both shards' blob zips and produced a real merged
`index.html`. All scratch directories (`blob-report-shard-*`, `all-blob-reports`,
`merged-html-report`) were deleted immediately after.

## 4. Finding (Medium) — weekly-quality-review.yml's flaky-detection mechanism cannot produce the
outcome its own comment claims

`weekly-quality-review.yml`'s header comment states its purpose is to "proactively hunt for newly-
flaky tests by re-running the regression selection with `--repeat-each=3`... this job's own
`ci-summary` step will surface any retry-pass found here exactly the same way the PR gate does." The
actual invocation is `--repeat-each=3 --retries=0`.

I constructed a real scratch test (`e2e/tests/zzz-scratch-audit-stage10-flaky.spec.ts`, deleted
afterward) that fails on exactly its 2nd invocation (tracked via a filesystem marker under this
session's scratchpad, since module-scoped JS state does not survive across repeat-each iterations —
confirmed live that each repeat is an independent process-level test case, the same discovery the
implementer's own Stage 10 log recorded for its own flaky-repro fixture). Run with the exact
`--repeat-each=3 --retries=0` shape: 2 passed, 1 failed, **exit code 1** — a real, ordinary test
failure, not Playwright's `flaky` outcome. Feeding that run's report to `ci-summary.ts` confirmed it:
`Flaky (retry-pass): 0`, `Failed: 1`, a hard `::error::` annotation, "**1 test(s) failed.**" in the
markdown summary — never the "warning, not blocking" framing the workflow's own comment describes.

**Root cause.** Playwright's `TestCase.outcome()` (what `normalizedReporter.ts`'s `classifyOutcome`
reads to decide `retry-pass` vs. ordinary failure — confirmed by reading its source directly) can
only report `"flaky"` when a *single test case* has multiple *results* with different outcomes, which
requires `retries > 0`. `--repeat-each` does not create multiple results of one test case; it creates
several independent test cases with the same title. With `retries: 0`, each repeat-each iteration's
own single result is either an ordinary pass or an ordinary failure — there is no retry for
Playwright to compare against, so `outcome()` can never be `"flaky"` for anything this specific
invocation shape produces.

**Is this a masked-defect risk?** No — the opposite. The job still fails loudly (a real, visible
`::error::` and a non-zero exit from the `playwright test` step itself, independent of
`ci-summary.ts`), so an intermittent test is not hidden; if anything it is reported more forcefully
than the "informational warning" the design intended. This is a real, verified inaccuracy in the
workflow's own design narrative — the specific mechanism it describes for surfacing flakiness does
not and cannot fire the way it says — but it does not violate this stage's "cannot appear as an
ordinary clean pass" acceptance criterion, since the run in question never looks like a clean pass
either way. Disclosed, not fixed live: fixing the underlying intent (genuinely detecting repeat-each
flakiness as a distinguishable warning rather than an ordinary failure) would mean either passing
`--retries=1` alongside `--repeat-each` in the weekly job or extending `ciSummary.ts`'s classification
logic to reason about repeated titles across the whole report — a real design change to a workflow
this stage's own task list marks "explicitly optional/best-effort," not a one-line fix, and not a
defect-hiding bypass on its own.

## 5. Finding (Medium, fixed live) — the Stage 10 tagging cheat sheet names a tag dimension that does
not exist under that name

Following PLAYWRIGHT_TESTING.md's own "First-test tutorial" literally (Section 3 below), I reached
its new "Tagging cheat sheet (Stage 10)" table, which lists a `special-purpose` dimension holding
`@visual`/`@accessibility`/`@external-service`. The table's own preface says this is "a quick-
reference copy of [`quality/tag-taxonomy.yaml`], not a second source of truth," so I opened that file
to cross-check it, as a first-time reader following that exact instruction would. `quality/
tag-taxonomy.yaml` has no dimension named `special-purpose` — the dimension holding those three tags
is named `test-type` (confirmed by reading the YAML directly: `- name: test-type` at line 131,
description "Cross-cutting test technique, orthogonal to feature area."). PLAYWRIGHT_TESTING.md's own
pre-existing Stage 06/07 material (line 447, unchanged by this stage) already correctly calls it
`test-type` — only this stage's new cheat-sheet table introduced the mismatched name. The same wrong
name had also propagated into `quality/manual-test-to-automation-worksheet.md`'s field-5 template row
("role / special-purpose / lifecycle"). Confirmed via `grep -rn "special-purpose"` across the repo
before fixing: exactly these two lines, no other occurrences.

This is a real, first-timer-facing documentation defect (a reader told to treat the real YAML as
authoritative would search it for a name that isn't there), but it is a pure prose rename with zero
functional surface — nothing in `pw:validate-metadata`, `pw:lint-tests`, or any schema reads this
table or the worksheet's own field labels, confirmed by re-running `pnpm pw:validate-metadata`
(unchanged: `20 requirements, 7 tag dimensions (33 tags)`) immediately after the fix. Per this audit's
own instruction that a trivially safe fix need not wait for a Medium/Low finding to be merely
disclosed, I fixed both occurrences directly (`special-purpose` → `test-type` in both files) rather
than leaving a one-word, zero-risk documentation error open. No locking regression test was written
for this one — the "revert and reproduce" protocol exists for a real behavioral defect, not a prose
string, and `pnpm exec tsc --noEmit`/`pnpm pw:validate`/`pnpm pw:test` were all re-confirmed clean
(**385/385 passed**) after the change.

## 6. Documentation walkthrough: following the first-test tutorial literally, as a new manual tester

Read `e2e/tests/guest-viewing.spec.ts` top to bottom first, exactly as "Walking through a reference
test" instructs, and could answer all four of its comprehension questions (what's being checked, what
Arrange sets up, what the one Act is, how Assert knows it worked) from the test file alone, with no
other file open — this held.

Then followed the "First-test tutorial" section step by step, using only what it and the files it
explicitly names say (`quality/requirements.yaml` for step 2, `e2e/fixtures/index.ts`'s fixture
descriptions for step 3, `WeddingGuestsPage`/`GuestRow` for steps 4/7). Picked `REQ-GUEST-LIST-
MANAGEMENT` (an existing, real requirement — no gap requiring "Adding a new requirement" first);
decided `@mutating` (the new test both seeds a guest via the API and changes the guest's RSVP status
through the real UI control, `GuestRow.setRsvpStatus`, which the tutorial's own step 3 language
already anticipates as a page/component-object method a test can call directly); wrote a small,
genuinely new (not copy-pasted) reference-style test —
`e2e/tests/zzz-scratch-audit-stage10.spec.ts`, "a planner can confirm a guest's RSVP status" — with
named Arrange/Act/Assert `test.step`s, governed metadata, and an `evidence.checkpoint()` call,
mirroring the reference tests' shape without duplicating either one's exact content. Ran the
tutorial's own step 8 commands verbatim: `pnpm exec tsc --noEmit` clean; `pnpm pw:lint-tests` clean
(reported `4 test file(s)` while the scratch file existed); `pnpm exec playwright test
--project=chromium e2e/tests/zzz-scratch-audit-stage10.spec.ts` — **passed on the first real
attempt**, no debugging needed; `--repeat-each=3` — **3/3 passed**. Step 9's `pnpm pw:report` served
the real HTML report (confirmed the server started without error before intentionally terminating
it). Step 10's `pnpm pw:validate` reported `Total: 386 tests in 37 files` (385 + the one new test),
exactly the expected increment. The scratch test file was deleted immediately after, confirmed absent
from `git status --short` and from `pnpm pw:lint-tests`'s file count afterward (back to `3 test
file(s)`).

**Verdict on the walkthrough itself: the tutorial works, end to end, on a genuine first attempt**,
which is the strongest form of confirmation this specific acceptance criterion asks for ("final
confirmation is the Stage 10 audit gate's own documentation walkthrough, not self-assessed here"). The
one real gap the walkthrough surfaced is Finding 2 above (the `special-purpose`/`test-type` mismatch),
discovered specifically by following the cheat sheet's own instruction to cross-check the real YAML —
exactly the kind of gap a genuine first-time reader, not merely a code reviewer, would find. No other
unclear, wrong, or knowledge-assuming step was found in the tutorial, the tagging cheat sheet (once
corrected), the common-commands table, the report-review guide, or the good/bad-examples table — each
claim in those sections was either directly exercised above or cross-checked against the real file it
names (e.g. every good/bad row's cited `pw:lint-tests` rule name matches a real rule, confirmed by
re-reading `lint-tests.ts`'s own rule list while reviewing this section).

## 7. Secrets, workflow structure, and the "cancellation"/"report-generation failure" scenarios

**Secrets.** `grep -rn "secrets\." .github/workflows/*.yml` returned zero matches, confirming the
claim directly rather than trusting it — no workflow references any GitHub repository secret.
`DATABASE_URL` is a hardcoded, ephemeral-service-container connection string (never a secret by
construction); `JWT_SECRET`/`ENCRYPTION_KEY` are generated via `openssl rand -hex 32` and written to
`$GITHUB_ENV`, which GitHub Actions never echoes to a log.

**YAML structure.** All three workflow files parse cleanly (`python3 -c "yaml.safe_load(...)"`, `OK`
for each). Every report-upload, `ci-summary.ts`, `pw:triage`, and `pw:review` step across all three
workflows carries `if: always()`, confirmed by reading each file in full — a real induced failure or
flaky test during this audit's own verification (Section 2 above) produced a real normalized run
report and native HTML report exactly as it would in CI, so "CI publishes usable reports even when
tests fail" is not merely a static claim here, it was exercised. `merge-reports` (`needs: [e2e]`,
`if: always()`) will still attempt to merge whatever shard blob-reports exist even if one shard's job
fails or is cancelled outright — a real, if unavoidable, limitation is that if a shard's job crashes
before even uploading its blob-report artifact, the merged report silently reflects only the
surviving shard(s); this does not mask the failure itself, since that shard's own `e2e` job entry
still shows red on the PR checks list (matrix jobs report independently, `fail-fast: false`), just the
combined HTML report's completeness. Not treated as a new finding since the actually-blocking signal
(a failed job) is never hidden, only the artifact's completeness in that one edge case.

**Cancellation.** `concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-
progress: true }` on `ci.yml` means a new push to the same branch/PR cancels an in-flight run. This
was reviewed statically, as disclosed up front — GitHub Actions' own cancellation semantics (whether
`if: always()` steps get a grace period to run before a cancelled job's remaining steps are skipped)
are runner/platform behavior this sandbox cannot exercise or falsify one way or the other; I did not
find anything in this workflow's own structure that assumes cancellation behaves any more favorably
than GitHub's ordinary guarantees, and did not find a claim in the spec or PLAYWRIGHT_TESTING.md that
overclaims live verification of cancellation specifically (unlike Finding 1, which does explicitly
claim live verification of a scenario that didn't reproduce as described). This part of the review is
a logical read of the YAML, not a live one, exactly as the audit brief anticipated.

## Findings summary

1. **Medium, disclosed, not fixed; description corrected by the orchestrating session's own
   independent re-verification.** `ci-summary.ts`'s header comment, the Stage 10 task list, its
   acceptance-criteria prose, and two `PLAYWRIGHT_TESTING.md` sections all claim, as a "verified
   live" fact, that a `--grep` pattern matching zero tests causes Playwright to exit `0` and write an
   all-zero-counts run report. The audit subagent reproduced directly, twice, against real spec files,
   that it actually exits `1` with `Error: No tests found.` — that correction holds. The audit
   subagent's further claim that this invocation "writes no report at all" does **not** hold: the
   orchestrating session independently re-ran the identical command (including the audit's own exact
   pattern string) in isolation three separate times and confirmed a real all-zero-counts run report
   IS written every time (`tests: []`, every count `0`, `selectionSummary.matchedCount: 0`), and that
   feeding its `runId` to `ci-summary.ts` correctly produces `⚠️ ZERO TESTS EXECUTED` with exit `1` via
   the ordinary report-classification path — not via the "no run reports found" fail-closed branch the
   audit credited (that branch exists and is a real second line of defense, but isn't what fires here).
   The real CI pipeline never reaches this exact scenario either way (`print-ci-selection.ts`'s own
   upstream zero-match guard prevents it), so no actual CI safety gap exists in any case — only an
   overclaimed, factually incorrect verification narrative (exit code `0` claimed, `1` actual), now
   independently confirmed and corrected rather than merely re-asserted. See Section 2.
2. **Medium, disclosed, not fixed.** `weekly-quality-review.yml`'s own comment claims its
   `--repeat-each=3` re-check will surface newly-flaky tests as a `::warning::` "exactly the same way
   the PR gate does." Reproduced directly: with the workflow's actual `--retries=0`, Playwright's
   `flaky`/retry-pass outcome can never fire for a repeat-each iteration, so a real intermittent
   failure instead surfaces as an ordinary `::error::` failure. Not a masked-defect risk (the job
   still fails, visibly), but the stated mechanism does not and cannot work as described. See Section
   4.
3. **Medium, fixed live (trivial, no regression test needed).** `PLAYWRIGHT_TESTING.md`'s new
   Stage 10 tagging cheat sheet and `quality/manual-test-to-automation-worksheet.md` both named a tag
   dimension `special-purpose`; the real, authoritative `quality/tag-taxonomy.yaml` (and this same
   guide's own older, unchanged Stage 06/07 material) calls it `test-type`. Fixed directly in both
   files; re-confirmed `pnpm exec tsc --noEmit`, `pnpm pw:validate` (`Total: 385 tests in 37 files`),
   and `pnpm pw:test` (**385/385 passed**) all clean afterward. See Section 5.

No High-or-above finding was found. Nothing resembling a write-scope bypass, a secret leak, a masked
test failure, or a genuinely misleading green check in the real, reachable CI pipeline was found
despite adversarial, real (not merely read) attempts at all four: a real induced pass, a real induced
consistent failure, a real induced flaky/retry-pass test, and a real induced empty-shard zero-test
run all classified exactly as documented once the actually-reachable invocation shapes were used.

## Cleanup

Every scratch test file created during this audit was deleted before it ended:
`e2e/tests/zzz-scratch-audit-stage10.spec.ts` (the tutorial walkthrough test),
`e2e/tests/zzz-scratch-audit-stage10-flaky.spec.ts` and its filesystem counter marker under this
session's scratchpad (the repeat-each/retries=0 probe), `e2e/tests/zzz-scratch-audit-stage10-
flaky2.spec.ts` (the real retries=1 flaky probe), and `e2e/tests/zzz-scratch-audit-stage10-fail.spec.ts`
(the real retries=1 consistent-failure probe). Every run report and native-HTML report these scratch
tests generated was identified by grepping `artifacts/playwright/runs/run-reports/*.json` for the
scratch test titles and deleted by exact ID; the corresponding `test-results/` trace/screenshot
directories were removed the same way. The scratch 2-shard/merge exercise's `blob-report-shard-*`,
`all-blob-reports/`, and `merged-html-report/` directories (repo-root scratch dirs, not under
`artifacts/`) were deleted immediately after use. The from-scratch clean-checkout tar archive and its
extracted directory (both under this session's own scratchpad, never inside the repository) were
deleted immediately after that exercise concluded. `git status --short` at the end shows only the
legitimate Stage 10 implementation files (`.github/workflows/`, the four new
`playwright-framework/{cli,reporting,tests}/*.ts` files, `quality/manual-test-to-automation-
worksheet.md` — the last two now including this audit's own documentation fix — plus the five
modified files `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`, `PLAYWRIGHT_TESTING.md`, `README.md`,
`playwright-framework/version.ts`, `playwright.config.ts`) plus this report — no scratch/probe files
remain anywhere in the tracked tree.

## Verdict

**PASS WITH FINDINGS.** Every Stage 10 acceptance criterion and audit-gate item was independently
re-verified with real commands rather than trusted from the implementation log: the clean-checkout
simulation was rebuilt from scratch and re-run end to end; the CI status-gating mechanism was tested
against real induced passes, failures, flaky/retry-pass results, and an empty-shard zero-test run,
each fed through the real `ci-summary.ts` CLI and inspected directly; a real 2-shard split and merge
reproduced the implementer's own claim exactly; the documentation walkthrough was performed literally
— a brand-new reference-style test was authored and passed on its first real attempt using only the
tutorial's own text and the files it names, which is the strongest available confirmation of the one
acceptance criterion Stage 10 explicitly deferred to this audit. Three Medium findings were surfaced
by genuinely adversarial reproduction rather than by re-reading the implementer's own claims: two are
documentation/design-narrative inaccuracies whose underlying safety property still holds through a
different, independently-verified mechanism (disclosed, left open, consistent with this framework's
own Stage 08/09 precedent for non-blocking findings); the third, a one-word tag-dimension-name
mismatch a first-time reader would hit by following the documentation's own cross-check instruction,
was fixed live on the spot since it carried zero functional risk. No High-or-above finding was found
despite deliberately adversarial attempts to construct one (a real zero-match `--grep`, a real
`--repeat-each`/`--retries=0` flaky case, a real 2-shard empty-shard scenario, a real cancellation-
adjacent job-dependency read) — every actually-reachable CI scenario this stage's acceptance criteria
care about was independently confirmed to behave safely. `pnpm exec tsc --noEmit`, `pnpm pw:validate`
(`Total: 385 tests in 37 files`), and `pnpm pw:test` (**385/385 passed**) were all re-run clean after
this audit's own fix. `git status --short` confirms only the legitimate Stage 10 implementation and
fix files plus this report remain.

**Orchestrator's own independent re-verification, performed before trusting or committing anything
from this audit (per this engagement's standing rule):** re-read this entire report in full;
confirmed the `special-purpose` → `test-type` fix is real in both files and matches the actual
`quality/tag-taxonomy.yaml` dimension name; independently re-ran `pnpm exec tsc --noEmit` (clean),
`pnpm pw:validate` (`Total: 385 tests in 37 files`), and confirmed `git status --short` shows only the
expected Stage 10 deliverables plus this report, no scratch artifacts. While re-verifying Finding 1
specifically (rather than accepting its "wrote no report at all" claim at face value), the
orchestrating session discovered and corrected a real inaccuracy in the audit subagent's own
write-up: a zero-match `--grep` invocation does, in fact, write a real all-zero-counts run report
(reproduced three separate times, including with the audit's own exact pattern string, each with an
isolated before/after directory listing), and `ci-summary.ts` correctly classifies that report as a
zero-test run via its ordinary report-reading path — not via the "no run reports found" fail-closed
branch the audit credited. This does not change the audit's bottom-line verdict (Medium, disclosed,
no actual CI safety gap) since the corrected mechanism is, if anything, a more direct confirmation
that the acceptance criterion holds — but it is exactly the kind of claim this engagement's standing
rule ("independently re-verify the audit subagent's claims, don't just trust its report") exists to
catch, and it has been corrected in place above (Section 2 and Finding 1) rather than left standing.
No other claim in this report was found to be inaccurate on independent re-verification.
