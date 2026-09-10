# Stage 05 Audit

Result: PASS WITH FINDINGS (two High-severity bugs found and fixed live during this audit, with locking regression tests; one Medium and two Low findings disclosed and left open; DEC-018's disclosed limitation reviewed and accepted as-is)
Auditor: Independent review subagent, fresh context with no memory of the implementation work, instructed to treat the code as unseen and to run real commands rather than trust the implementation log's prose.
Date/time: 2026-09-10
Repository is a git repo (working tree, no commits made by this audit — see "Corrections made" for why).

## Scope

Verify Stage 05 (tag-expression runner and safe execution workflow) against `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`'s Stage 05 task list, acceptance criteria, and audit gate, DEC-015 through DEC-018, and the precedent set by `quality/audits/stage-04-audit.md`. The live app (`pnpm dev`, already running on `http://localhost:3000`, confirmed via `curl` returning 200) and a real Postgres-backed database were used throughout — nothing here is mocked. Every file named in the audit brief was read in full before any command was run.

## Files reviewed

- `playwright-framework/runner/tagExpression.ts` (in full, including DEC-015's fix)
- `playwright-framework/runner/parseRunArgs.ts` (in full)
- `playwright-framework/cli/run-tests.ts` (in full)
- `e2e/support/globalSetup.ts`, `e2e/support/productionGuard.ts`, `e2e/support/env.ts` (in full)
- `playwright-framework/metadata/schemas.ts` (`SavedSelectionSchema`/`SavedSelectionsFileSchema`/`RunResultFileSchema` additions) and `playwright-framework/metadata/loaders.ts` (`loadSavedSelections`)
- `playwright-framework/validation/discoverTestMetadata.ts` (pre-existing Stage 04 module `run-tests.ts` now depends on — spot-checked for correctness, not re-audited from scratch)
- `quality/tag-taxonomy.yaml`, `quality/saved-selections.yaml`
- `playwright-framework/tests/tagExpression.spec.ts`, `playwright-framework/tests/parseRunArgs.spec.ts` (existing, pre-audit)
- `PLAYWRIGHT_TESTING.md`'s "Running tests by tag" / "Production and mutation safety" sections, `README.md`'s Stage 05 additions

## Verification commands run (numbers I personally observed, not taken from the log)

- `pnpm exec tsc --noEmit` — clean, before and after this audit's fixes.
- `pnpm pw:test` — **189/189 passed** before any fix (matches the implementer's claim); **194/194 passed** after this audit's fixes (5 new locking tests: 1 in `tagExpression.spec.ts`, 4 in a new `buildPlaywrightInvocation.spec.ts`).
- `pnpm pw:validate` — clean before and after (`tsc` clean, `Metadata OK: 20 requirements, 7 tag dimensions (33 tags)...`, `Lint OK: 3 test file(s), 2 discovered test(s), 0 hard failures`, `Total: 194 tests in 19 files` after the fix).
- `git status --short` at the end — only legitimate source changes and this report remain; no scratch/probe files (see "Corrections made" for exactly what changed).

## 1. Compare runner selection with direct Playwright discovery

The real, live app suite carries exactly **2** tagged application tests under `defineQualityTest` (`guest-management.spec.ts` → `@mutating @feature:guests @risk:normal @suite:regression`, `guest-viewing.spec.ts` → `@readonly @feature:guests @risk:normal @suite:regression`). I built my own query matrix independently of `tagExpression.spec.ts`'s existing 10×6 synthetic matrix and ran each of the following three ways: (a) `pnpm pw:run "<expr>" --list`, (b) a direct `pnpm exec playwright test --project=chromium --grep '<compiled pattern>' --list` (pattern obtained from a scratch script calling `compileToGrepPattern` directly, never hand-derived, to remove my own transcription error as a variable), and (c) a scratch script cross-checking `evaluateExpression` against the same pattern with synthetic tags for the adversarial cases:

| Expression | preview | direct --grep --list |
|---|---|---|
| `@readonly` | 1 | 1 |
| `@mutating` | 1 | 1 |
| `@readonly OR @mutating` | 2 | 2 |
| `@feature:guests` | 2 | 2 |
| `@feature:guests AND @readonly` | 1 | 1 |
| `NOT @quarantined` | 2 | 2 (after fix — **37 before**, see Finding 2) |
| `NOT @readonly` | 1 | 1 (after fix — **36 before**) |
| `(@readonly OR @mutating) AND NOT @quarantined` | 2 | 2 |
| `@feature:guests OR NOT @feature:guests` (tautology — "matches everything") | 2 | 2 (after fix — **37 before**) |
| `@feature:guests AND @feature:tables` (satisfiable per taxonomy, empirically zero real matches) | refused, "0 tests out of 2 discovered" | `Error: No tests found` — agrees |
| `@readonly AND @mutating` (contradiction) | refused pre-discovery with the specific conflicting pair named | never reached Playwright — agrees |

Two real, distinct bugs were found this way (not in the pre-existing unit suite) and fixed live — see "Corrections made" below. After both fixes, every row above agrees exactly, including a real (non-`--list`) execution of `pnpm pw:run "NOT @quarantined"`, which ran exactly the 2 tests preview showed (previously it would have run 37).

Beyond the live suite (too small — 2 tagged tests — to exercise every adversarial shape on its own), I probed the compiler directly with a scratch script and synthetic taxonomy entries for cases the audit brief specifically called out:

- **Tags that are substrings of each other** (`@a` vs `@ab`): reproduced a real false-positive (`@a` spuriously matched a test tagged only `@ab`) and false-exclusion (`NOT @a` spuriously excluded it) before the fix; both agree with `evaluateExpression` after it. An exhaustive pairwise check of all 33 real taxonomy tags found **no** such collision today, so this was dormant, not currently exploitable — but the taxonomy's colon-namespaced naming convention (`@feature:guests`, `@risk:critical`, ...) is exactly the style most likely to grow one later (e.g. a future `@feature:guests-import` beside today's `@feature:guests`).
- **Deeply nested NOT/AND/OR**: `(@readonly OR @mutating) AND NOT @quarantined` and a hand-built 5-level-deep nested expression both parse and evaluate correctly, matching `evaluateExpression`.
- **An expression matching everything**: `@feature:guests OR NOT @feature:guests` (a tautology) — see Finding 2, now fixed.
- **An expression matching nothing**: both the "logically contradictory" case (`@readonly AND @mutating`, caught by `findContradictions` before discovery) and the "syntactically satisfiable but empirically empty" case (`@feature:guests AND @feature:tables`, correctly refused only at the zero-match stage, not misclassified as a contradiction) were verified to take the right code path.

**Re-deriving DEC-015's own reasoning**: the anchoring analysis in the Decision Log is correct — `--grep` and `RegExp.test` both search unanchored, every node is zero-width, and an un-anchored `NOT` can be satisfied by retrying the match after the negated tag's own text, so a leading `^` is necessary and (for the *retry-position* class of bug) sufficient. It is not, however, the *only* unanchored-regex trap in this compiler — see Finding 1.

## 2. Production guards and adversarial tag input

All four production/mutation combinations were exercised against a simulated production host (`APP_URL=http://localhost:3000 PRODUCTION_HOSTNAMES=localhost`, the real running dev server standing in for "production"):

- **Mutating + `--allow-production`** → refused unconditionally: *"Refusing to run: 'localhost' is a configured production host and the current selection includes at least one @mutating test... with or without --allow-production."*
- **Read-only, no `--allow-production`** → refused: *"...Even a fully read-only selection needs this invocation to explicitly pass --allow-production..."*
- **Read-only + `--allow-production`** → allowed, and it genuinely ran the real read-only test against the "production" host (1 passed), with a valid run manifest written.
- **`--list` (preview) in all three states** → never executes anything, and each preview message honestly states what a real run would do (refused unconditionally / refused without the flag / allowed), matching the actual behavior exactly.

**DEC-018 (bare `playwright test --grep` bypasses the guard)**: reproduced live, not assumed. With `PRODUCTION_HOSTNAMES=localhost` and an **ambient** `PLAYWRIGHT_ALLOW_PRODUCTION=1` (simulating a variable left over in a shell), a bare `pnpm exec playwright test --project=chromium --grep '@mutating' e2e/tests/guest-management.spec.ts` **ran the mutating test against the "production" host** with no `pw:run` involved at all. This is a real gap, exactly as disclosed. My judgment: **acceptable as an honestly-disclosed limitation, not blocking**, because (a) `PRODUCTION_HOSTNAMES` defaults to empty in this repo (DEC-005) — there is no real production host configured today, so this is currently dormant, not actively exploitable; (b) Playwright's `globalSetup` genuinely has no public API to inspect a `--grep`-resolved test list before browser launch, so this isn't a shortcut the implementer chose over a better option — it's a real tooling constraint; (c) both `PLAYWRIGHT_TESTING.md` ("Production and mutation safety" subsection) and `README.md` state the mitigation prominently and directively ("Always run tagged application tests through `pw:run`, never Playwright directly, when a production `APP_URL` is configured"), not buried in a footnote. I log a **Medium, open** finding recommending a stronger mechanism for a future stage (e.g. a CI-level or deployment-level restriction that makes a bare `playwright test` invocation impossible once a real production host is configured), consistent with the Decision Log's own framing that this was left for the audit to judge, not silently accepted.

**Adversarial CLI input** — every case produced a friendly message, non-zero exit, and never reached Playwright:

- Shell/injection-shaped expressions (`@readonly; rm -rf /`, backticks, `$()`, pipes, SQL-injection-shaped quotes) — all rejected as syntax errors naming the exact offending character and position.
- Unknown tag (`@doesnotexist`) — rejected with a pointer to `quality/tag-taxonomy.yaml`.
- Contradictory expression (`@readonly AND @mutating`) — rejected with the specific conflicting pair named.
- Malformed `--workers abc` — rejected, "requires a positive integer."
- Unrecognized flag (`--danger-flag`) — rejected, names the actual supported flag set.
- An expression built from ~2000 sequential `OR`s (extremely long, but flat) — parsed and ran fine (no stack risk; repeated infix operators at one precedence level are parsed iteratively, not recursively).
- **Deeply nested parentheses (~3000+ levels)** — see Finding 3 (Medium, open, not fixed).
- `--selection` immediately followed by another recognized flag (`--selection --list`) — see Finding 4 (Low, open, not fixed).
- Passing both a raw expression and `--selection` — rejected with clear guidance to pick one.
- No arguments at all — rejected with a pointer to `--help`.

`execFileSync` is used with an argv array throughout (confirmed by reading, not assumed) — no shell string ever appears in the invocation, so none of the injection-shaped input above is a shell-injection risk in the first place; the parser rejecting it earlier is defense in depth, correctly implemented.

## 3. Friendly error messages for a non-developer user

Every failure path funnels through the CLI's own `fail()` helper (confirmed by reading `run-tests.ts` end to end), which produces a consistent `pw:run cannot continue:` prefix, a plain-language explanation, and — where relevant — a concrete next step ("Check quality/tag-taxonomy.yaml for the exact spelling," "re-run with --allow-production if you really mean to read from production," "wrap the whole expression in quotes"). I judge these genuinely readable by a non-developer test runner: they name the *specific* offending tag/character/flag rather than a generic parse failure, and every message ends with what to do next, not just what went wrong. The one exception is Finding 3 below (a raw `RangeError` stack trace on pathologically deep nesting), which is not friendly — but see that finding's severity judgment for why it isn't blocking.

## Corrections made (live, with locking regression tests)

**Finding 1 (HIGH, FIXED) — `compileToGrepPattern` had no tag-boundary anchoring; a tag that is a literal prefix of another tag's name produces a false match.** DEC-015's leading-`^` fix closes the *retry-position* unanchored-regex trap, but a second, distinct trap survived it: each tag compiled to a bare `(?=.*@tag)` lookahead with no assertion on what follows the tag's own text, so `@a` is a literal regex substring of `@ab`, and a test tagged only `@ab` would spuriously satisfy the expression `@a` (and `NOT @a` would spuriously *exclude* it). Reproduced directly against `compileToGrepPattern`/`evaluateExpression` with synthetic `@a`/`@ab` tags before touching anything. An exhaustive pairwise substring check over all 33 real taxonomy tags found no current collision, so this was latent, not actively firing — but it is a real bug in the compiler itself, and the taxonomy's own naming convention makes a future collision plausible.
- **Fix**: added a trailing tag-boundary assertion, `(?![A-Za-z0-9:_-])`, to every compiled tag literal (`playwright-framework/runner/tagExpression.ts`), so a tag can only match when it isn't immediately followed by more of the same tag-character class. A tag can never be a false-positive *suffix* match of another (every tag's `@` must be followed immediately by its own text, so no left-boundary assertion is needed).
- **Locking test**: `playwright-framework/tests/tagExpression.spec.ts` — new test `"a tag that is a literal prefix of another tag never spuriously matches (or excludes) it"`, using a synthetic taxonomy with `@a`/`@ab` so it doesn't depend on the real taxonomy staying collision-free.

**Finding 2 (HIGH, FIXED) — the actual spawned Playwright invocation could select tests preview never showed, violating the stage's own acceptance criterion "Preview and actual execution select the same tests."** `--grep` matches a compiled pattern against every test's *full title* across the whole `--project=chromium` project — including untagged tests (`e2e/tests/framework-health.spec.ts`, everything under `e2e/tests/unit/**`) that `discoverAllTests()`/`evaluateExpression` (what preview is built from) never considers, because they don't go through `defineQualityTest`. Any expression an untagged test can trivially satisfy — a bare `NOT`, or an `OR` with a `NOT` branch — matches it too. This is not hypothetical: verified live against the real repo, `pnpm pw:run "NOT @quarantined" --list` reported 2 matched tests, while the equivalent direct `--grep` invocation (before the fix) matched **37 tests across 5 files** — and running `pnpm pw:run "NOT @quarantined"` for real, before the fix, would genuinely have executed all 37, not the 2 the tool told the user it would.
- **Fix**: the spawned `playwright test` invocation now also receives the matched tests' own spec files as positional arguments alongside `--grep` (`playwright-framework/cli/run-tests.ts`, logic extracted into a new pure, testable module `playwright-framework/runner/buildPlaywrightInvocation.ts`, mirroring the existing `parseRunArgs.ts` precedent for testing CLI internals without executing `main()`). Playwright then only ever discovers tests inside those files; `--grep` continues to do the real narrowing within them exactly as before.
- **Re-verified live after the fix**: direct `--grep` count for `NOT @quarantined` restricted to the 2 matched files is 2 (was 37); a real, non-preview `pnpm pw:run "NOT @quarantined"` execution ran exactly 2 tests and wrote a correct, schema-valid run manifest.
- **Locking tests**: new `playwright-framework/tests/buildPlaywrightInvocation.spec.ts` (4 tests) — asserts the exact argv shape, that an unrelated untagged file (`framework-health.spec.ts`, anything under `unit/`) is never included regardless of what `--grep` alone would match, that a file matched by more than one test is de-duplicated, and that `--workers`/`--repeat-each`/`--reporter` are still forwarded correctly only when provided.

Both fixes were re-verified end-to-end against the real running app (not just unit tests): `pnpm exec tsc --noEmit` clean, `pnpm pw:test` 194/194, `pnpm pw:validate` clean, and the full query matrix in Section 1 re-run live after each fix.

A small, non-functional doc-accuracy issue was also corrected: `quality/saved-selections.yaml`'s `readonly` selection description said production reads are safe "with `PLAYWRIGHT_ALLOW_PRODUCTION=1`" alone, omitting that DEC-017 also requires `--allow-production` on that specific invocation. Corrected to state both requirements. No test needed (a description string, not executable logic); re-verified `pnpm pw:validate` still parses the file cleanly.

## Findings disclosed and left open (not blocking)

- **Finding 3 (Medium, open)**: an expression with roughly 3000+ levels of nested parentheses crashes the CLI with a raw, uncaught `RangeError: Maximum call stack size exceeded` and a Node.js stack trace, rather than `fail()`'s friendly message — because the recursive-descent parser recurses once per paren-nesting level with no depth guard. Verified the practical threshold sits between 1500 (fine) and 3000 (crashes) levels on this environment — implausible to hit by accident from real human-typed input, and it fails *safely* (a nonzero exit, no incorrect test selection), so I judged it Medium rather than High and did not fix it live: a proper fix means either an explicit depth guard or rewriting the recursive-descent parser to be iteratively safe, which is more surgery than this audit's time budget should spend on a pathological, not realistic, input shape. Left open for a future stage.
- **Finding 4 (Low, open)**: `parseRunArgs`'s `--selection` handler unconditionally consumes the very next argv token as the selection name, even if that token is itself a recognized flag (e.g. `pnpm pw:run --selection --list` treats `"--list"` as the selection name and fails with `no saved selection named "--list"`). Not a security issue (still fails cleanly, non-zero exit) and not silently wrong, just a confusing message for the specific case of typing `--selection` with nothing after it followed immediately by another flag. Left open; a real fix would have `--selection` refuse a value that itself starts with `--`.
- **Finding 5 (Low, open, informational)**: the compiled `--grep` pattern matches against a test's *entire* title, including its human-authored, non-tag portion — so a title that happened to literally contain `@sometag`-shaped text in its prose (not as a declared tag) could theoretically satisfy an unrelated tag expression. No current test title contains `@` anywhere (checked directly), so this is purely theoretical today, and it is an inherent property of building on top of Playwright's own `--grep`/title-matching design (there is no Playwright API to grep against only the declared-tag portion of a title) rather than a defect this stage introduced. Worth a lint rule forbidding `@` in human-authored titles if this framework grows much further, but not blocking.

## Verdict

**PASS.** Every Stage 05 acceptance criterion was independently re-verified against the real running app and real Postgres-backed test suite, not trusted from the implementation log: AND/OR/NOT/parentheses and saved selections return the expected inventories; after this audit's two live fixes, preview and actual execution select the *same* tests in every case tried, including the adversarial ones that previously diverged; unknown tags and shell/injection-shaped input are rejected safely and in plain language; mutating tests cannot start against a configured production host under any flag combination (including the always-refused case with `--allow-production` passed); and a zero-test selection is reported plainly, non-zero exit, never confused with a passing run of nothing. `pnpm exec tsc --noEmit`, `pnpm pw:test` (194/194), and `pnpm pw:validate` are all clean as of this report. DEC-018's disclosed limitation was reproduced live and judged an acceptable, honestly-disclosed gap rather than a blocking one, given it is currently dormant (no production host configured) and clearly documented with directive guidance. Two High-severity bugs were found by this audit (not by the pre-existing unit suite) and fixed live with locking regression tests; one Medium and two Low findings are logged above as open, non-blocking follow-ups for a future stage. Stage 05 may be marked complete on the Progress Dashboard.
