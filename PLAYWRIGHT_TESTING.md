# Writing and reviewing Playwright tests for Seatwise

This is the authoring guide the Stage 04 acceptance criterion asks for: "A manual tester can
follow the guide to understand and modify a reference test." If you have never touched this
framework before, start with **Walking through a reference test** below, then come back to the
rest as you need it.

The two reference tests this guide keeps pointing at are:

- `e2e/tests/guest-management.spec.ts` — the **mutating** reference test (adds a guest).
- `e2e/tests/guest-viewing.spec.ts` — the **read-only** reference test (views a guest already
  on the list).

Read both once before writing your own test. Everything below explains *why* they look the way
they do.

## Directory and naming conventions

| What | Lives in | Naming |
|---|---|---|
| Application test files | `e2e/tests/<feature>.spec.ts` | one file per feature area; the file's own basename is that feature's "slug" |
| Pure-logic unit tests for `e2e/` support code | `e2e/tests/unit/*.spec.ts` | not application tests — no page/selector surface, excluded from lint's raw-selector rule and from `pw:lint-tests`' file discovery |
| Page objects | `e2e/pages/<Name>Page.ts` | one class per page/route |
| Component objects | `e2e/components/<Name>.ts` | one class per reusable widget (e.g. a list row) |
| Fixtures | `e2e/fixtures/index.ts` | the single place every application test imports `test`/`expect`/`defineQualityTest` from |
| Test-data helpers | `e2e/data/` | `ids.ts` (unique naming), `api.ts` (setup/cleanup via the real API) |
| Cross-cutting support | `e2e/support/` | auth, redaction, artifact paths, evidence capture |
| The reusable framework itself | `playwright-framework/` | metadata schemas/validation, scoring, static-analysis lint rules, CLI scripts — never imports anything app-specific from `e2e/` |

**Test IDs are namespaced by file.** A test declared in `guest-management.spec.ts` must have an
id starting with `guest-management.` (e.g. `guest-management.add-guest-appears-in-list`). This
is enforced by `pnpm pw:lint-tests` (the "naming-convention" check) — a mismatched id fails the
lint step, not just a code review comment. The convention exists so a test ID alone tells you
which file to open; you should never need to search the whole repo to find a test by its ID.

## Every application test imports from `e2e/fixtures/index.ts`

```ts
import { defineQualityTest, expect, test } from "../fixtures/index.js";
```

Never `import { test } from "@playwright/test"` directly in an `e2e/tests/**` file (framework
self-tests like `framework-health.spec.ts` are the sole, explicitly-documented exception — see
"Framework self-tests" below). The fixtures module is what wires up page objects, authentication,
test-data setup/cleanup, and evidence capture — importing straight from `@playwright/test` gets
you none of that, and the raw-selector lint rule can't tell your test apart from a framework
self-test if you do.

## Metadata and tags (Stage 02)

Every test is declared with `defineQualityTest(metadata, body)`, not raw `test(title, body)`.
`metadata` is validated at collection time — before a single browser launches — against:

- the shape in `playwright-framework/metadata/schemas.ts` (`id`, `title`, `objective`,
  `expectedOutcome`, `requirementIds`, `tags` are all required),
- the live tag taxonomy (`quality/tag-taxonomy.yaml`) — unknown tags, a missing
  `@readonly`/`@mutating` classification, or a declared tag conflict all fail immediately, and
- (as of Stage 04) the real, discovered test suite as a whole, via `pnpm pw:lint-tests` — duplicate
  IDs across files, a `requirementIds` entry that doesn't exist, and (new this stage) a
  `requirementIds` entry pointing at a **retired** requirement ("stale metadata": the requirement
  still exists in `quality/requirements.yaml` but the business has withdrawn it, so citing it is a
  drift signal even though the plain "does this ID exist" check wouldn't catch it).

An empty `requirementIds` array is allowed but is flagged `needsHumanReview` rather than silently
accepted — see `quality/test-value-model.md` for why an unmapped test can't be scored.

## Page and component objects (spec Section 7.2)

- **All application selectors live in a page or component object.** A test file should read as
  business intent ("open the Guests tab", "add a guest") — never `page.locator(...)`,
  `page.getByRole(...)`, `.click()`, `.fill()`, etc. directly in a test file. `pnpm pw:lint-tests`
  enforces this (the `raw-selector-in-test` rule) against every real test file.
- **Page/component objects take `Page`/`Locator` through the constructor only** and keep no other
  mutable state. See `e2e/pages/BasePage.ts` and `e2e/components/GuestRow.ts` — a fresh instance
  is constructed per test via a fixture (`e2e/fixtures/index.ts`), so nothing can leak between
  tests.
- **Prefer the app's own stable attributes** — an `id` where the app has one
  (`e2e/pages/LoginPage.ts`'s `#login-email`), an `aria-label` prefix where it doesn't
  (`e2e/components/GuestRow.ts`'s `"First name for "` convention). When neither exists, a CSS-class
  selector is allowed but must be disclosed in a doc comment, not silently relied on as if it were
  stable (see `LoginPage.errorMessage()`).
- **Reads editable fields by value, not text.** A field a signed-in owner can edit renders as an
  `<input defaultValue>`, and an input's *value* is never part of an element's rendered text
  content — `hasText`/`toContainText` will silently match nothing against such a row. Read
  `.inputValue()` instead (see `GuestRow.firstName()`'s own doc comment; this bit the framework's
  own reference test once during Stage 03, which is exactly why it's written down here).

### Framework self-tests

`e2e/tests/framework-health.spec.ts` is the one file in `e2e/tests/**` that imports directly from
`@playwright/test` and calls `page.locator(...)` on its own inline HTML. It is testing that
Playwright itself works — browser launch, page evaluation — never the Seatwise app, so there is no
page object it could move that selector into. Spec Section 7.2 explicitly carves this out
("except selectors used exclusively by framework self-tests"), and the file documents it with a
`pw-lint-exception` comment (see "The exception mechanism" below) rather than silently escaping the
rule some other way.

## Arrange / Act / Assert, with named `test.step`s

Structure a test's body as three named steps:

```ts
async ({ managedWedding, weddingGuestsPage, evidence }, testInfo) => {
  const { firstName, lastName } = await test.step("Arrange: open the wedding's Guests tab", async () => {
    await weddingGuestsPage.goto(managedWedding.id);
    await weddingGuestsPage.openGuestsTab();
    return uniquePersonName(testInfo.workerIndex);
  });

  await test.step("Act: submit the add-guest form", async () => {
    await weddingGuestsPage.addGuest({ firstName, lastName });
  });

  await test.step("Assert: the new guest appears with the expected name and status", async () => {
    // ...expect(...) calls...
  });
}
```

Named steps show up individually in the HTML report and in trace viewer, so a reviewer — or a
future you, debugging a failure six months from now — can see which phase broke without reading
the test body line by line. `test.step` is imported from the same `e2e/fixtures/index.ts` module
as `test` itself (it's the same fixture-extended `test`, not a second import).

## Test isolation and reliability (spec Section 7.3)

- Every test signs up its **own** fresh account (`account` fixture) and creates its **own**
  wedding (`managedWedding` fixture) — never depend on data another test created, and never assume
  a particular execution order. `pnpm pw:test`'s default is a single worker locally, but nothing
  about these tests assumes that: see "Verifying independence" below for how this is actually
  checked, not just assumed.
- **Everything your test creates is cleaned up for you** — including extra weddings beyond the one
  `managedWedding` provides. See "Test-data cleanup (TS-102)" below for what each layer covers, and
  for the one thing you do have to do by hand: tagging a wedding name you construct yourself.
- **Never catch and suppress an assertion or navigation failure.** A `catch` block must rethrow,
  attach evidence (`testInfo.attach(...)`), or itself assert — never just log and move on. This is
  enforced by `pnpm pw:lint-tests` (`swallowed-error`); see `managedWedding`'s own cleanup handling
  in `e2e/fixtures/index.ts` for the one legitimate exception (a cleanup failure is attached as a
  warning rather than thrown, specifically so it can never mask the test's own pass/fail result —
  that fixture lives outside `e2e/tests/**`, so the lint rule doesn't even see it).
- **No fixed sleeps.** `page.waitForTimeout(...)` and bare `setTimeout(...)` are both flagged
  (`fixed-wait`). Use Playwright's web-first assertions (`expect(locator).toBeVisible()`,
  `expect.poll(...)`) and automatic waiting instead.
- **Every test must execute at least one `expect(...)` call**, or it can pass without validating
  anything (`missing-assertion`).
- **`test.only` must never be committed** (`test-only`) — it silently excludes every other test in
  the run.
- **`test.skip`/`.fixme`/`.fail` must carry a reason.** Playwright's own API already has a place
  for this — `test.skip(condition, "why")` — so pass one; an unreasoned skip is flagged
  (`unreasoned-skip`).

## Test-data cleanup (TS-102)

Test data is cleaned up in **three layers**. You normally get all three for free — this section
exists so you know what you can rely on, and what to do in the one case you can't.

**1. `managedWedding` — the one wedding your test is handed.** Created before your test, deleted
after it. Nothing to do.

**2. The `weddingData` fixture — every other wedding your test creates.** On teardown it deletes
every wedding created through `weddingData.createWedding(...)`, *and* sweeps anything else still
visible to your test's account. That catch-all is what covers weddings made through the UI
(`dashboardPage.createWedding(...)`) or a raw `context.request.post("/api/v1/weddings", ...)`,
neither of which passes through the helper.

This is safe because the `account` fixture signs up a brand-new account per test, so every wedding
that account can see was created during that test. A wedding your test was only *invited* to (owned
by another disposable account) returns 403 on delete and is left alone.

> **So: you do not need a `try/finally` around wedding creation.** If you create a wedding in any
> of the three ways above, it is already cleaned up. If you delete one yourself mid-test, that's
> fine too — `deleteWedding` untracks it, and a second delete is a tolerated 404.

**3. `globalTeardown` — the run-level backstop.** After the whole suite, `e2e/support/globalTeardown.ts`
removes any marker-tagged wedding still in the database. This catches what layers 1 and 2
structurally can't: a worker that crashed before teardown ran.

This runs **automatically** — nothing to opt into. To inspect what it would remove without
removing anything:

```bash
PW_TEARDOWN_SWEEP=dry-run pnpm pw:run:regression
```

It deletes **only** rows carrying the marker, refuses outright if `APP_URL` resolves to a
production hostname, and never fails the run — a sweep error is logged, not thrown, so it can't
mask what the tests themselves reported.

### The cleanup marker — why naming matters

Every name `uniqueTitle(...)` produces carries `TEST_DATA_MARKER` (`pwqa-fixture`, see
`e2e/data/ids.ts`), and the sweep deletes **only** rows carrying it. That is an allowlist of what
may be deleted, not a denylist of what to keep — a real wedding cannot be matched by accident.

**If you construct a wedding name yourself** rather than using `uniqueTitle` — usually because your
test asserts on the name's own text, as the search and sort specs do — wrap it:

```ts
import { tagTestName, uniqueToken } from "../data/ids.js";

const token = uniqueToken(testInfo.workerIndex);
const nameAlpha = tagTestName(`Alpha ${token}`);   // ← not just `Alpha ${token}`
```

The marker is a **suffix**, so prefix assertions and search-by-label scenarios keep working, and
relative alphabetical ordering between names is unchanged.

Untagged names still get cleaned up by layers 1 and 2 — the marker only matters for layer 3, which
is exactly the case where the other two failed. An untagged wedding left behind by a crashed worker
stays in the database forever.

## Evidence (spec Section 7.4, built in Stage 03)

- A **successful** test captures a screenshot only through the `evidence.checkpoint(name,
  validationDescription)` fixture helper, after a meaningful validation point — never a raw
  `page.screenshot(...)` call (`raw-screenshot-in-test`). The name and description are attached
  alongside the screenshot so a report reader knows what the picture is supposed to prove.
- A **failed** test automatically gets a failure screenshot, trace, and (via the `diagnostics`
  auto-fixture) redacted console/network diagnostics — you don't have to do anything extra for
  this; it's already wired into every test through the fixtures module.
- All captured evidence text is passed through `e2e/support/redaction.ts` before being attached, so
  authorization headers, bearer tokens, JWTs, cookies, and sensitive JSON/query fields never end up
  in a report. If you're adding a new kind of evidence capture, redact it the same way rather than
  attaching raw text.

## Enforcement: `pnpm pw:lint-tests`

Run `pnpm pw:lint-tests` (folded into `pnpm pw:validate`) to check every rule above against the
real test suite, statically — no browser launch required:

1. **Static source rules** (`playwright-framework/validation/lintRules.ts`): raw selectors, raw
   screenshots, fixed waits, `test.only`, unreasoned skip/fixme/fail, swallowed errors, missing
   assertions.
2. **Governed-metadata validation against the real suite**
   (`playwright-framework/validation/discoverTestMetadata.ts` feeding
   `playwright-framework/metadata/validateMetadata.ts`): unknown tags, duplicate IDs, missing
   requirement mappings, and stale (retired) requirement references.
3. **Naming convention**: a test's ID must be prefixed with its file's slug.

A **hard failure** in any of these fails the command (non-zero exit) — the same "invalid metadata
fails before execution" posture the framework has had since Stage 01/02, now extended to cover
authoring-standard violations, not just YAML shape.

### The exception mechanism

Sometimes a rule genuinely doesn't apply — `framework-health.spec.ts`'s raw selector against its
own inline HTML is the one real example in this repo today. Document it in place with a single-line
comment immediately above (or trailing on) the flagged line:

```ts
// pw-lint-exception: raw-selector-in-test -- one-sentence rationale, kept on one line
await expect(page.locator("h1")).toHaveText("...");
```

- The rule name after the colon must match the rule being suppressed (or `*` to suppress
  whatever rule fires at that location).
- **Keep the rationale on one line.** The checker only looks at the flagged line and the single
  line immediately before it — a rationale that wraps onto a second comment line will not be seen,
  and the exception will not apply.
- Every exception in use is printed by `pnpm pw:lint-tests` under "noted for human review" — it
  does not fail the build, but it is never silent either. A reviewer should treat a new exception
  the same as any other code-review comment: does the rationale actually hold up? `test.only`
  should essentially never have a legitimate exception — if you find yourself writing one, that's
  a sign to just remove the `.only` instead.

### Bad-pattern fixtures

`playwright-framework/tests/fixtures/badPatternSnippets.ts` contains deliberately broken example
source (a `test.only`, a swallowed error, a test with no assertions, and so on) as plain string
constants — never real `.spec.ts` files, so Playwright never collects or runs any of the broken
code. `playwright-framework/tests/lintRules.spec.ts` feeds each one to the checker and asserts it's
caught, and also feeds the checker the real reference tests and asserts **zero** issues — a
regression in either direction (a missed bad pattern, or a false positive against real tests) fails
`pnpm pw:test`.

## Running tests by tag: `pnpm pw:run` (Stage 05)

`pnpm pw:run` is the one command for running (or previewing) a subset of the suite by tag — the
authoritative wrapper around `playwright test`; it never reimplements test selection or execution
itself, only computes a safe, validated selection and hands off to the real Playwright CLI.

```bash
pnpm pw:run "@readonly AND @feature:guests"     # a raw boolean tag expression
pnpm pw:run --selection smoke                    # a saved selection (quality/saved-selections.yaml)
pnpm pw:run "<expr>" --list                      # preview only -- print matched tests, run nothing
```

Expression syntax: `@tag` literals, `AND`/`OR`/`NOT` (or `&&`/`||`/`!`), and parentheses — e.g.
`"(@readonly OR @mutating) AND @feature:guests AND NOT @quarantined"`. `NOT` binds tighter than
`AND`, which binds tighter than `OR`; parentheses override. Convenience wrappers exist for the four
saved selections in `quality/saved-selections.yaml`: `pnpm pw:run:readonly`, `pw:run:smoke`,
`pw:run:regression`, `pw:run:critical`.

Before anything runs, `pw:run`:

1. Parses the expression and validates every referenced tag against `quality/tag-taxonomy.yaml` --
   an unknown tag (a typo, a retired tag) is rejected here, in plain language, before Playwright is
   ever invoked.
2. Detects a self-contradictory expression (e.g. `@readonly AND @mutating`, two tags from the same
   `exactly-one` dimension) and rejects it with the specific pair that can never both apply.
3. Statically discovers the real, tagged test suite (the same discovery `pnpm pw:lint-tests` uses)
   and evaluates the expression against each test's own tags — the exact same `evaluateExpression`
   this module's own unit tests cross-check, test by test, against the compiled `--grep` pattern
   Playwright actually receives, so preview and actual execution can never select different tests.
4. Refuses a zero-match selection outright (non-zero exit, explicit message) rather than treating
   "0 tests, 0 failures" as a quiet success.
5. Runs the production/mutation preflight (below) before ever spawning Playwright.

Only supported, explicitly-validated options are ever forwarded to the underlying `playwright test`
invocation: `--workers <n>`, `--repeat-each <n>`, `--reporter <list|line|dot|html|json>`. Anything
else is rejected as an unrecognized option. The compiled `--grep` pattern (and every other value)
reaches Playwright via `execFileSync` with an argv array — never a shell string — so nothing in an
expression, however adversarial, is ever interpreted by a shell.

### Production and mutation safety

`pw:run` computes, for real, whether the current selection includes any `@mutating` test, and
refuses outright — unconditionally, no flag overrides it — to run a mutating selection against a
configured production host (`PRODUCTION_HOSTNAMES`). A fully read-only selection against production
additionally requires **both** `PLAYWRIGHT_ALLOW_PRODUCTION=1` in the environment **and** this
specific invocation to pass `--allow-production` explicitly — an ambient env var left set in a shell
profile is deliberately not treated as consent for a run someone didn't mean to make production-
targeted. `--list`/preview mode never blocks on this (nothing executes), but it always tells you
what would happen if you dropped `--list` and ran it for real.

This coverage is scoped to runs launched through `pw:run` (or its saved-selection wrappers): a bare
`playwright test --grep ...` invoked directly bypasses this computation entirely, since Playwright's
own `globalSetup` has no API to inspect a `--grep`-resolved test list on its own (see the spec's
Stage 05 Decision Log). Always run tagged application tests through `pw:run`, never Playwright
directly, when a production `APP_URL` is configured.

### Run manifests

Every real (non-preview) `pw:run` invocation writes a run manifest to
`artifacts/playwright/runs/run-manifests/<runId>.json`, validated against
`RunResultFileSchema` (`playwright-framework/metadata/schemas.ts`): the normalized expression, the
compiled `--grep` pattern, every matched test ID, the exact execution configuration, the base URL,
the git commit, and timestamps. Per-test pass/fail outcomes (`outcomes: []` today) are deliberately
left for Stage 06's reporter to populate — Stage 05's manifest proves what was asked for and how it
was configured, not what happened once it ran.

## Test-run reports (Stage 06)

Every `playwright test` invocation — however it was launched (`pw:run`, `pw:test`, or a raw
`playwright test`) — additionally produces a normalized, schema-validated **run report**, written
by a custom reporter (`playwright-framework/reporting/normalizedReporter.ts`, registered in
`playwright.config.ts` alongside Playwright's own native `list`/`html` reporters — it supplements
them, never replaces them) to:

```
artifacts/playwright/runs/run-reports/<runId>.json   # machine-readable, validated against RunReportSchema
artifacts/playwright/runs/run-reports/<runId>.html   # a self-contained, offline-viewable companion
```

View the most recently generated report locally with:

```bash
pnpm pw:report:run              # serves the most recent run report
pnpm pw:report:run <runId>      # serves a specific run by ID
```

This starts a small static file server over `artifacts/playwright/runs/` (default port 4300,
override with `PW_REPORT_PORT`) so the report's relative links — the native Playwright HTML report,
failure screenshots, traces, videos, success-checkpoint screenshots — all resolve exactly as they do
under `pnpm pw:serve-report` for the native report alone. Opening the `.html` file directly (e.g.
`file://...`) also works for the report's own text and status information, but its links to
sibling artifacts (screenshots, traces) only resolve when served, since browsers restrict relative
`file://` navigation.

**Shared `runId` with Stage 05's manifest.** When launched via `pw:run`, the run manifest
(pre-execution, "what was asked for") and this run report (post-execution, "what actually happened")
share the same `runId` (passed via the `PW_RUN_ID` environment variable from `run-tests.ts` to the
spawned Playwright child process) so the two can be cross-referenced. They are deliberately never
merged into one file or one writer — the manifest is written by the CLI process itself before
Playwright even starts, the report by a reporter running inside the spawned Playwright child once
it finishes, and forcing one to wait on or patch the other's file would add exactly the kind of
fragile cross-process coordination this framework has otherwise avoided.

**Status categories.** Every test is classified into exactly one of eight statuses (Section 10.2),
derived entirely from Playwright's own `TestCase.outcome()` and final `TestResult.status` — never
guessed:

| Status | Meaning |
| --- | --- |
| Passed (`initial-pass`) | Passed on its first attempt. |
| Passed on retry (flaky) (`retry-pass`) | Failed at least once, but the final attempt passed (Playwright's own `outcome() === "flaky"`). |
| Failed (`consistent-failure`) | Failed, with at least one of the test's own named `test.step`s recorded. |
| Timed out (`timeout`) | Did not complete within the configured timeout. |
| Skipped (`skipped`) | `test.skip()`/`test.fixme()`, or a conditional skip, without the `@quarantined` tag. |
| Failed as expected (`expected-failure`) | Used `test.fail()` and failed as expected — the intended outcome. |
| Quarantined (`quarantined`) | Skipped **and** tagged `@quarantined` (`quality/tag-taxonomy.yaml`'s documented, not-yet-enforced convention for a deliberately disabled-but-tracked test). |
| Setup/infrastructure failure (`setup-failure`) | A failure (or an interrupted run) with **zero** of the test's own named steps recorded — most consistent with a fixture, hook, or environment problem rather than the test's own assertions. |

`setup-failure` is explicitly disclosed as a best-effort heuristic, not a certainty: "zero named
steps recorded" is a strong signal the failure happened before the test body's own Arrange/Act/
Assert steps ever ran, but it is inference from shape, not Playwright telling us the failure was
infrastructural. Playwright's own fifth `TestResult.status`, `interrupted` (a worker crash, or the
whole run cancelled mid-test), has no dedicated category of its own in these eight — it is folded
into `setup-failure` for the same reason: it never reached its own pass/fail determination at all.

**What each test's entry contains**, all read directly off Playwright's own `TestCase`/`TestResult`/
`TestStep` objects (never re-parsed from source or fabricated): the governed metadata
(`objective`, `expectedOutcome`, `requirementIds` — read back from the `annotation` entries
`defineQualityTest` already attaches, Stage 02/03), every named Arrange/Act/Assert step with its own
pass/fail and duration, a count of `expect`-category steps Playwright recorded as actually executed
(`assertionCount` — Section 10.1: "every claimed successful validation is backed by an executed
assertion"), the true source file and line (see below), success-checkpoint screenshots and their
validation text (`e2e/support/evidence.ts`'s convention), and, for a failure, the sanitized error
message/stack trace plus links to Playwright's own screenshot/trace/video attachments. A plain-
language "why this passed"/"why this failed" explanation is generated deterministically from this
same structured data (step/assertion counts, the first failing step's title) — never a fabricated
narrative disconnected from what Playwright actually recorded.

**Source location correction.** A test defined through `defineQualityTest` has its `TestCase.location`
resolved by Playwright to the wrapper's own internal call site
(`playwright-framework/metadata/defineQualityTest.ts`), not the real spec file the test author wrote
it in — this is systematic, not a fluke: Playwright resolves a test's location to wherever
`test()`/`testFn()` is textually invoked during collection, and for a wrapped test that is always
inside the wrapper module. The reporter corrects this by cross-referencing the same AST-based static
discovery `pnpm pw:lint-tests` already performs (`playwright-framework/validation/discoverAllTests.ts`),
keyed by each test's own declared `id`, and falls back to Playwright's own (already-correct)
`test.location` only for tests that don't go through the wrapper at all (`framework-health.spec.ts`,
`e2e/tests/unit/*.spec.ts`).

**Redaction and paths.** Every string that could contain user data (error messages, stack traces,
console/network diagnostics) passes through this framework's existing `redact()`
(`e2e/support/redaction.ts`), and every absolute path is rewritten repo-relative before it is ever
written to the report — never an absolute path (Section 10.1), consistent with this framework having
no local-editor deep-linking configured (DEC-004).

**Failure mode.** If HTML rendering itself fails for any reason, the already-written JSON is left
untouched and the reporter exits non-zero (`process.exitCode = 1`) with the error printed loudly —
Section 10.1: "report generation errors cause a nonzero result without erasing raw Playwright
output." Playwright's own `list`/`html` reporters are unaffected either way, since they run
independently.

## Suite review, coverage analysis, and test catalog (Stage 07)

`pnpm pw:review` generates the **suite review**: a single point-in-time snapshot of the whole
discovered test suite's coverage, value, quality, duplication, and health, written to

```
artifacts/playwright/runs/suite-reviews/<reviewId>.json   # machine-readable, validated against SuiteReviewSchema
artifacts/playwright/runs/suite-reviews/<reviewId>.html   # a self-contained, offline-viewable companion
```

`pnpm pw:review:serve` serves the most recent one (or `pnpm pw:review:serve <reviewId>` for a
specific one, default port 4301, override with `PW_REVIEW_PORT`) so its links back to each test's
source file resolve. Unlike a run report, generating a suite review never launches a browser or a
test — it only reads the real discovered test suite, the governance YAML files under `quality/`,
and whatever Stage 06 run-report history already exists on disk (zero, one, or many reports; all
are treated as normal, never required).

**How a test's value and quality scores get computed.** Stage 02 built the scoring arithmetic
(`computeScore`/`applyOverride`/`bandForValueScore`) and the 14-criterion value/quality model
(`quality/test-value-model.yaml`) but had no real per-test evidence to drive it with. Stage 07 closes
that gap with a three-way split (Decision Log DEC-021), because Section 8.6 is explicit that missing
business information must be flagged as `needsHumanReview`, never invented:

- **9 criteria are computed mechanically**, fresh on every `pnpm pw:review` invocation, from real
  tool output — never hand-typed, so they can never silently go stale as the codebase changes.
  Quality: independence-and-parallel-safety (does the test import the shared fixtures module?),
  deterministic-waiting-and-state-control and page-component-object-and-locator-design (both read
  straight from `pnpm pw:lint-tests`'s own findings for that file), test-data-setup-and-cleanup
  (shared fixtures again, capped at 8/10 to disclose the real, permanent account-cleanup gap —
  DEC-012, no account-deletion endpoint exists), readability-and-diagnostic-steps (named
  `test.step` count, from the latest real run report when one exists, else a source scan),
  evidence-and-failure-diagnostics (from the run report's recorded success checkpoints/failure
  bundle, else a source-text scan for `evidence.checkpoint()`), and
  metadata-completeness-and-standards-compliance (objective length + requirementIds presence).
  Value: unique-coverage, computed by comparing every test against every other discovered test
  (same requirement + same data-impact tag + a shared feature tag + objective-text similarity —
  see "Duplicate detection" below, which reuses the identical comparison).
- **2 criteria require genuinely reading what a specific test's assertions verify** — quality's
  assertion-strength-and-objective-traceability and value's security-compliance-data-integrity —
  and are read from a hand-authored `quality/test-evaluations.yaml` entry (a human or an AI
  evaluator citing real evidence, keyed by `testId`). A test with no entry there scores
  `needsHumanReview: true` on both, with a rationale explaining exactly what to add.
- **4 value criteria are permanently, mechanically forced to `needsHumanReview: true`** —
  business-criticality, user-impact-and-frequency, risk-and-defect-likelihood,
  release-decision-usefulness — because no data source in this repo yet quantifies a
  requirement's real business priority (`quality/requirements.yaml` has no priority/impact field,
  and every real requirement is still `status: needs-human-review`, not `confirmed` — DEC-009).
  This means every current test's **value** score is `provisional` today (4 of 6 criteria
  unresolved), while **quality** scores are fully calculable once a `quality/test-evaluations.yaml`
  entry exists. This is expected, not a bug — it will stop being true once a human confirms real
  requirement priorities.

An override in `quality/value-overrides.yaml` (Stage 02, still empty in this repo) always applies on
top of a calculated score, never replacing it silently — the report shows both.

**Coverage.** Two numbers, both stating their own denominator (Stage 07 acceptance criterion:
"coverage percentages state their denominator and exclusions"):

- **Requirement coverage** — covered / total requirements, where the denominator is every
  requirement with `status: needs-human-review` or `confirmed` (`placeholder` and `retired`
  requirements are excluded, and the exclusion count is stated alongside the percentage).
- **Risk-weighted coverage** (Decision Log DEC-022) — each covered requirement is weighted by the
  **highest** `@risk:*` tier among its covering test(s) (critical=4, high=3, normal=2, low=1); an
  **uncovered** requirement is conservatively weighted as `@risk:critical` (4), since its real risk
  is unconfirmed without a test. This is a deliberate, proven invariant: risk-weighted coverage can
  never read higher than plain requirement coverage (`computeCoverage.spec.ts` asserts this
  directly against synthetic data) — missing coverage never looks better just because its real risk
  is still unknown.

The report also separately calls out requirements **covered only by unhealthy tests** (every
covering test is currently quarantined, stale, never-executed, or failing — distinct from
"uncovered", a more severe bucket with zero covering tests at all) and **dimension coverage**
(per-tag counts across every taxonomy dimension — data-impact, feature, risk, role, suite,
test-type, lifecycle — including tags with zero uses, disclosed as `0` rather than omitted).

**Duplicate detection** (`playwright-framework/coverage/detectDuplicates.ts`) flags two tests as
possible duplicates only when **all four** hold: they share at least one `requirementId`, the
**same** data-impact tag (`@readonly` vs `@mutating` — critically, a *different* data-impact tag
means never flagged, even with everything else matching, since e.g. "view an existing guest" and
"add a guest" are different actions on the same requirement), a shared feature tag, and an
objective-text word-overlap similarity of at least 0.5. This is proven against the real suite: the
`guest-viewing`/`guest-management` pair shares a requirement and a feature tag but has different
data-impact tags, and is correctly never flagged
(`detectDuplicates.spec.ts`). Flagged pairs are always a **recommendation for human review**, never
an automatic deletion.

**Test health** (`classifyTestHealth`) is exactly one of `healthy`, `quarantined` (has the
`@quarantined` tag), `never-executed` (no run-report history at all), `stale` (last run older than
the configured freshness window — 14 days by default, override per-invocation with
`--freshness-window-days <n>`), or `failing` (most recent recorded status was
consistent-failure/timeout/setup-failure/skipped).

**The prioritized review queue** (`playwright-framework/coverage/buildReviewQueue.ts`) is a worklist,
not a restatement of the full roster — a test appears only when a concrete, additive reason fires
(never-executed, failing, stale, quarantined, the only coverage for an at-risk-and-unhealthy
requirement, a duplicate-candidate member, a low quality score — with an extra bonus when that's
paired with a high value score, missing hand-authored evaluation criteria, or disproportionate
execution time relative to the suite average alongside a low value score). Deliberately excluded:
every test's value score being `needsHumanReview` on the 4 forced-unresolvable business criteria is
**not** by itself a queue reason — with no real business-priority data yet, that is true of the
entire suite today, and surfacing it per-test would swamp the queue with noise instead of signal.

**Changes from the previous review** (`playwright-framework/coverage/diffSuiteReviews.ts`) — added/
removed tests and every test's value/quality total score change — appear automatically once a prior
suite-review JSON exists on disk (the most recently modified one is used); the very first review
says plainly that there is nothing to compare against yet.

**The HTML report** lets you search by title/ID/tag and filter the test catalog by quarantined-only,
needs-human-review-only, stale-or-never-executed-only, risk tag, feature tag, and result status —
same "self-contained, offline-viewable, real `<input>`/`<select>` filters reachable by Tab" posture
as Stage 06's run report. Every discovered test's entry expands to show its full value and quality
criterion breakdown (points, confidence, and the exact rationale behind every judgment — mechanical
or hand-authored), last known execution result and age, and any recommendations requiring human
review.

## Claude Code integration (Stage 08)

Section 11 asks for the framework's deterministic tools (everything above) to be reachable through
Claude Code's own skills, subagents, and hooks, rather than reimplemented in prose. Everything below
lives under `.claude/` and is committed like any other framework source.

### Skills (`.claude/skills/`, invoked as `/pw-...`)

| Skill | Responsibility |
|---|---|
| `/pw-bootstrap` | Resume/advance the staged spec build one stage at a time, gated on a passing audit |
| `/pw-author-test` | Author a new test from an approved requirement or manual case |
| `/pw-run-tests` | Preview a tag selection, safety-check it, run it, produce reports |
| `/pw-review-suite` | Discover, validate, score, and generate the Stage 07 suite-review report |
| `/pw-triage-failures` | Classify a failed run's root cause from real evidence, never fix it |
| `/pw-repair-test` | Repair exactly one explicitly-confirmed test, hook-enforced scope |
| `/pw-validate-framework` | Run every offline deterministic check (schemas/lint/types/tests/discovery) |

Every skill's own `SKILL.md` states, in this order: when to use it and when not to, required
arguments, allowed scope of file changes, preflight checks, the deterministic commands it invokes,
expected output, stop conditions requiring a human, and an explicit prohibition against silently
changing application behavior or test expectations. None of them reimplement tag parsing or scoring
in prose — every one delegates to the real `pnpm pw:*` CLIs documented earlier in this file.
`/pw-repair-test` sets `disable-model-invocation: true` (only a human can invoke it, never the
assistant on its own initiative) and `context: fork` into the `playwright-repair` subagent below,
rather than running in the main session.

### Subagents (`.claude/agents/`)

| Subagent | Tools | Role |
|---|---|---|
| `playwright-reviewer` | `Read, Grep, Glob, Bash` | Independent stage-audit and suite-quality evaluator |
| `playwright-triage` | `Read, Grep, Glob, Bash` | Failure-evidence analyst |
| `playwright-repair` | `Read, Grep, Glob, Bash, Edit, Write` | Scoped repair worker, forked into only by `/pw-repair-test` |

`playwright-reviewer` and `playwright-triage` have no `Write`/`Edit`/`NotebookEdit` in their tools
list at all, and each also carries its own `PreToolUse` hook
(`.claude/hooks/readonly-bash-guard.mjs`, scoped to that subagent alone via its frontmatter's own
`hooks:` field) that denies those three tools outright as defense in depth, and blocks any `Bash`
call matching a documented, intentionally conservative mutation blocklist (`rm`, `mv`, `sed -i`,
output redirection, mutating `git` subcommands, and similar — see the script's own comments for the
full list and rationale). This is not sandboxing — Claude Code has no per-command Bash sandbox today
— but it is enough to catch the overwhelming majority of accidental or careless attempts from an
agent whose entire system prompt already assumes it never writes anything.

`playwright-repair` is deliberately given `Edit`/`Write`, but only within a hook-enforced scope — see
the next section — and its own `Bash` calls are separately guarded by the same
`readonly-bash-guard.mjs` blocklist, so every file mutation it makes goes through `Edit`/`Write`
where the scope guard can actually reason about the target, never through a raw shell command.

### The scoped repair write guard (hook requirement #1)

`.claude/hooks/repair-write-guard.mjs`, wired only into `playwright-repair`'s own frontmatter
(matcher `Edit|Write`), enforces two independent conditions on every write that subagent attempts:

1. **The target must fall under a directory `quality/repair-allowed-dirs.yaml` lists.** This file is
   committed and human-owned (today: `e2e/tests`, `e2e/pages`, `e2e/components` — deliberately
   excluding `e2e/fixtures`, `e2e/data`, `e2e/support`, all of `playwright-framework/`,
   `quality/*.yaml`, `package.json`, `playwright.config.ts`, and application source under
   `apps/`/`packages/`). No skill, hook, or subagent in this framework ever writes to it — widening
   it is a human editing the repo directly, which is what "unless the human explicitly expands
   scope" (Section 11.4) means in practice.
2. **The target must also appear in `artifacts/playwright/repair-scope.json`'s `approvedPaths`** —
   an ephemeral, gitignored, per-session file `/pw-repair-test`'s own preflight writes only after
   explicitly confirming the exact target with a human. Nothing is writable by `playwright-repair`
   until this file names it, even fully within the outer allowlist above.

A `Write` is additionally refused unless the target file already exists — repair modifies an
already-identified test, it never authors a new one. Every check fails safe: a missing or
unparseable `quality/repair-allowed-dirs.yaml`, a missing or unparseable
`artifacts/playwright/repair-scope.json`, or a target outside the repository root entirely all deny,
never default to permissive.

**Stage 09 added two more independent conditions to this same hook** (see "Failure triage and
controlled test repair" below for the maintenance report they both depend on):

3. **A coarse, self-contained diff-safety proxy.** The canonical structural check for a test's own
   quality (`checkTestSource`, `playwright-framework/validation/lintRules.ts`) is TypeScript and
   needs a build step this dependency-free `.mjs` hook cannot take on. `assessDiffRisk` inside the
   hook itself is a deliberately coarser regex-based stand-in: it compares the file's real current
   content against what the attempted `Edit`/`Write` would make it, and flags a decreased
   `expect(...)`/`expect.poll(...)` count, a new `.waitForTimeout(...)` call, a new
   `.only`/`.skip`/`.fixme`, a new raw `page.locator()`/`page.$()`/`page.getBy...()` call inside a
   test file, or *any* change at all to a page/component object file (treated as an always-flagged
   proxy for "a locator may have been broadened", since a coarse regex hook cannot itself judge
   locator strictness). Each flagged category is denied unless
   `artifacts/playwright/repair-scope.json`'s `justifiedExceptions` array already names that exact
   category with a non-empty, human-given reason — populated only by `/pw-repair-test`'s own
   preflight, after asking the human specifically about that risk. This is a second, coarser safety
   net alongside (never instead of) the canonical `pw:lint-tests` check `post-edit-validator.mjs`
   already runs post-edit.
4. **The most recent maintenance report must classify this test as `repairAllowed: true`.** The hook
   independently loads `artifacts/playwright/maintenance/*.json` (the newest by mtime), finds the
   finding whose own "Test source" evidence link names the file being written, and denies outright
   if no such finding exists (no triage yet means no repair yet) or if its `repairAllowed` is
   `false` (always the case for "Probable application defect" and "Insufficient evidence" — Stage
   09's acceptance criteria). This is mechanical enforcement of "prohibit repair for probable
   application defects and insufficient-evidence outcomes" — `/pw-repair-test`'s own preflight is
   expected to check this too, but the hook does not trust that alone.

### The lightweight post-edit validator (hook requirement #2)

`.claude/hooks/post-edit-validator.mjs`, wired project-wide in `.claude/settings.json` as a
`PostToolUse` hook (matcher `Edit|Write`, so it applies in the main session and every subagent
alike). It cannot block anything — the edit has already happened by the time a `PostToolUse` hook
runs — so it runs the smallest relevant offline check and surfaces a failure loudly if one exists:

- A changed `quality/*.yaml` governance file → `pnpm pw:validate-metadata` (zod-only).
- A changed `*.ts` file under `e2e/` or `playwright-framework/` → `pnpm exec tsc --noEmit`.
- ...and if that file is itself a test spec → also `pnpm pw:lint-tests` (AST-only, no browser).
- Anything else → a no-op.

It never launches a browser-backed test project, per Section 11.4's explicit "never run the complete
browser suite after every file edit." Fails open on anything it can't make sense of (malformed
input, a file that no longer exists) — a hook that can't block anyway should never manufacture a
false failure report.

### The scoped bootstrap stage-gate check (hook requirement #3)

`.claude/hooks/stage-gate-check.mjs`, wired project-wide in `.claude/settings.json` as a
`PreToolUse` hook (matcher `Edit|Write`). It is "scoped" to exactly one file: the first thing it does
is check whether the edit's target is `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` at all, and immediately
gets out of the way (a fast no-op) if it isn't — which is true for the overwhelming majority of edits
in this repository. When it is that file, the hook computes what the file's content would become if
the edit were applied (reading the real current content and, for an `Edit`, applying the same
`old_string`/`new_string` substitution the tool itself would make) and requires: for every Progress
Dashboard line the result would leave checked (`- [x] Stage NN — ...`),
`quality/audits/stage-NN-audit.md` must already exist and its own first `Result:` line must start
with `PASS` (matching every real audit from Stage 00 through Stage 07 — `PASS WITH FINDINGS` counts,
a verdict that isn't a form of PASS, or a missing audit file, does not). It checks specifically the
file's *first* `Result:` line, not merely whether the string appears anywhere in the document — a
Stage 08 audit finding (fixed) showed that a substring-anywhere check could be satisfied by an
unrelated `Result: PASS` line elsewhere in the file (e.g. a quoted example in an appendix) even while
the audit's own real verdict was a `FAIL`. This fails safe: an `Edit` whose `old_string` can't be
located in the file's real current content is denied rather than assumed harmless, since this script
cannot otherwise know what the resulting content would be.

### Testing the hooks

Every one of the four hook scripts above has its own `playwright-framework/tests/hooks/*.spec.ts`
covering an allowed case, a denied case (where applicable — `post-edit-validator` can't block, so its
"denied" case is "surfaces a real failure" instead), a malformed-input case, and a missing-field
case, run as real spawned `node <script>.mjs` child processes fed real stdin — never by importing
internals, since a hook has none to import; it is a script Claude Code itself spawns. The two
guards that depend on repository state (`repair-write-guard`, `stage-gate-check`) run against a
throwaway temporary fake repository root for every test, never this real repo's own files, so they
can run safely alongside a real `/pw-repair-test` or `/pw-bootstrap` session.
`repair-write-guard.spec.ts` covers Stage 09's two additional conditions the same way: a fake
maintenance report and `justifiedExceptions` fixture per test, never the real
`artifacts/playwright/maintenance/` this repo's own `pnpm pw:triage` writes to.

### When Claude Code features are unavailable

This framework targets current, documented Claude Code project skills, subagent, and hook syntax
(verified against the live documentation while building this stage, not assumed from training data).
If an installed Claude Code version predates project skills or the subagent/hook fields used here
(`hooks:` in subagent frontmatter, `disable-model-invocation`, `context: fork`), the `/pw-*` slash
invocations simply won't appear — there is no separate legacy `.claude/commands/` compatibility layer
committed alongside them, per Section 11.1's "create compatibility command files only when the
installed version requires them, and record that decision": no version in use during this build ever
required one, so none was created. In that situation, every workflow above is still fully usable by
running its documented `pnpm pw:*` commands directly from a shell — nothing in this framework's
actual behavior depends on the skills/hooks layer existing; it is a convenience wrapper over
commands that already work standalone.

## Failure triage and controlled test repair (Stage 09)

Section 10.4 asks for a maintenance report that classifies each real failure into one of 7
categories, with a defined set of required fields per failure, and Section 09's acceptance criteria
require that classification to actually gate what `/pw-repair-test` may do — not just describe it.

### `pnpm pw:triage` — the maintenance/failure-triage CLI

`playwright-framework/cli/triage.ts` reads one already-completed Stage 06 run report **by run ID,
never rerunning anything** (`pnpm pw:triage [--run-id <id>]`, defaulting to the most recent report
on disk), classifies every real failure in it (`status` one of `consistent-failure`, `timeout`,
`setup-failure`), and writes a schema-validated `artifacts/playwright/maintenance/<reportId>.json`
+ `.html` (`MaintenanceReportSchema`, `playwright-framework/metadata/schemas.ts`). `pnpm
pw:triage:serve [reportId]` serves it (mirroring `pw:review:serve`'s own fix for relative source-
file links resolving from a one-directory-deep served page — `serve-maintenance-report.ts` serves
`artifacts/playwright/` as one root precisely so a maintenance report's own sibling links into
`runs/run-reports/...` resolve the same way).

DEC-027 replaced an earlier, unused Stage 02 placeholder schema (`MaintenanceClassificationSchema` —
a 5-category enum that predated Section 10.4's real requirements) with one matching Section 10.4
exactly: 7 categories (`probable-application-defect`, `probable-test-defect`,
`intended-application-change`, `test-data-problem`, `environment-or-infrastructure-problem`,
`intermittent-flaky-behavior`, `insufficient-evidence`) and all 12 required per-failure fields (test
and run IDs; classification and confidence; expected vs. observed behavior; first failed step;
evidence links; comparison notes; evidence for/against an application defect and a test defect;
recommended next action; `repairAllowed`; `repairAllowedFiles`; a suggested defect description).
`MaintenanceFindingSchema` itself refuses (via a zod `.refine`) any document where
`repairAllowed: true` accompanies `probable-application-defect` or `insufficient-evidence` — a
second, schema-level backstop behind `classifyFailure.ts`'s own logic and `repair-write-guard.mjs`'s
independent re-check.

### Classification tiers (DEC-028) — `playwright-framework/triage/classifyFailure.ts`

Deliberately mirrors DEC-021's mechanical/hand-authored/forced-human-review split (Stage 07,
`evaluateTest.ts`), applied to failure classification instead of scoring:

1. **Mechanical (computed fresh, every run)** — only the two categories a structural signal can
   actually support without reading the failure's meaning: `environment-or-infrastructure-problem`
   (the run report's own `status: "setup-failure"`, or a known infrastructure error-text pattern —
   `ECONNREFUSED`, a browser launch failure, and similar) and `intermittent-flaky-behavior` (this
   exact test has both passed and failed across different real run reports on file — read via
   `runReportHistory.ts`, the same Stage 07 already depends on).
2. **Hand-authored (`quality/failure-classifications.yaml`)** — the remaining four categories
   (`probable-application-defect`, `probable-test-defect`, `intended-application-change`,
   `test-data-problem`) genuinely require judging what a specific failure's error text and the
   test's intent mean, which this module never guesses at from a regex. Mirrors
   `quality/test-evaluations.yaml`'s established shape exactly: per-test entries (optionally scoped
   further to one distinct error text via `errorFingerprint`, since one test can fail more than one
   distinct way over its lifetime), each citing real evidence for/against both an application defect
   and a test defect.
3. **Insufficient evidence (fail-closed default)** — a failure matching neither tier gets
   `insufficient-evidence`, `confidence: "low"`, `needsHumanReview: true`, `repairAllowed: false` —
   the same fail-closed default `evaluateTest.ts` uses for an unscored criterion, never a fabricated
   middle-ground guess.

Every finding also cross-references the latest Stage 07 suite review (when one exists) for sibling
tests covering the same requirement(s), surfaced as a `comparisonNotes` fact — evidence toward
"this looks scoped to one specific behavior" rather than a suite-wide environment problem, never a
deciding signal on its own.

### Repair is gated on the maintenance report, not just asked to check it

`repair-write-guard.mjs`'s two new Stage 09 conditions (documented in full under "The scoped repair
write guard" above) are what actually enforce Section 09's acceptance criteria:

- **Repair cannot broaden selectors, remove assertions, add sleeps, or skip a test without explicit
  justified review** — the diff-safety proxy, gated on `repair-scope.json`'s `justifiedExceptions`.
- **Prohibit repair for probable application defects and insufficient-evidence outcomes** — the
  maintenance-report `repairAllowed` re-check, independent of whatever `/pw-repair-test`'s own
  preflight or a human believes.

`post-edit-validator.mjs` was also extended this stage: any changed test, page/component object,
fixture, governance YAML, or scoring/evaluation/coverage module now also triggers `pnpm pw:review`
(Section 09 task: "Regenerate the suite-review report after any test, page object, fixture,
metadata, or scoring change") — still read-only/discovery work, never a browser-backed run, so it
stays within the "lightweight" bound Section 11.4 sets for this hook.

### Extending an existing test vs. authoring a new one

`.claude/skills/pw-author-test/SKILL.md` now states this explicitly (Section 09 task): when new
functionality is a direct, small extension of an already-tested behavior, add a focused
`test.step` to the existing test; when it's its own distinct behavior or failure mode, author a
separate test with its own `requirementIds`/objective. Never overload one test with unrelated
outcomes just because they touch the same page.

### Visual-regression baselines: not applicable

Section 09's "prohibit automatic visual-baseline updates" has nothing to gate today — this
repository has no visual-regression/snapshot testing anywhere (`toHaveScreenshot`/`toMatchSnapshot`/
`--update-snapshots`, confirmed absent via a repo-wide grep before this stage was built). Disclosed
here rather than silently skipped; if visual-regression testing is ever added, its baseline-update
path must go through the same explicit-human-approval discipline as everything else in this section.

### Live verification (Stage 09)

Verified against a real, deliberately-broken scratch test (`e2e/tests/_scratch-stage09-live-
verification.spec.ts`, mirroring Stage 06's own precedent — created, run, triaged, and deleted along
with every artifact it produced; never committed): a real `pnpm pw:run` failure was classified
`insufficient-evidence` (no mechanical signal or hand-authored entry matched it — the correct,
honest default), `pnpm pw:triage:serve` served the report with every evidence/source link resolving
(200, confirmed via direct HTTP requests; a path-traversal and a bare-repo-root request both still
404), and a real attempt to write to that classified-`insufficient-evidence` test through
`repair-write-guard.mjs` itself (not just its test suite) was denied, citing the exact
classification. The mechanical `environment-or-infrastructure-problem` and
`intermittent-flaky-behavior` tiers, and the hand-authored tier, are covered by real unit tests
(`playwright-framework/tests/classifyFailure.spec.ts`) rather than a live run, since reproducing a
genuine environment outage or a naturally-occurring flake on demand would mean deliberately
destabilizing the shared dev environment this whole framework runs against.

## Verifying independence

Reference tests are expected to pass individually, regardless of what ran before them, and under
parallel/repeated execution. In practice:

```bash
# individually
pnpm exec playwright test --project=chromium e2e/tests/guest-management.spec.ts
pnpm exec playwright test --project=chromium e2e/tests/guest-viewing.spec.ts

# both, repeated
pnpm exec playwright test --project=chromium e2e/tests/guest-management.spec.ts e2e/tests/guest-viewing.spec.ts --repeat-each=3

# both, in parallel across multiple workers
pnpm exec playwright test --project=chromium e2e/tests/guest-management.spec.ts e2e/tests/guest-viewing.spec.ts --repeat-each=2 --workers=4
```

Playwright 1.63 has no built-in "reverse selection order" flag (and its own file-discovery order
inside one invocation doesn't change based on the order file paths are passed on the command line),
so "runs correctly regardless of selection order" is verified instead by invoking the two reference
tests as **separate process runs in swapped order** (test B's run, then test A's run) — a
meaningfully equivalent check given every test creates and tears down its own account and wedding
through the real API, with no shared mutable state for order to affect either way.

## Walking through a reference test

If you're new to this framework, read `e2e/tests/guest-viewing.spec.ts` top to bottom without
opening any other file first. You should be able to answer, from the test file alone:

- What is this test checking, in plain language? (`objective`/`expectedOutcome` in the metadata,
  plus the step names.)
- What does it set up before the behavior under test runs? (The "Arrange" step.)
- What is the one action being validated? (The "Act" step — for this test, a navigation, not a
  write.)
- How does it know the behavior worked? (The "Assert" step's `expect`/`expect.poll` calls.)

If you can't answer all four from the test file alone, that's a bug in the test (or in this guide)
— selector mechanics belong in `e2e/pages/`/`e2e/components/`, not in the story the test file
tells.

## Modifying a reference test

To add a new assertion to an existing reference test: add it inside the relevant `test.step`, using
`expect`/`expect.poll` against a page/component object method — never a raw locator. To add a new
page interaction: add a business-readable method to the relevant page object first (see
`WeddingGuestsPage.addGuest()` for the shape), then call that method from the test. Run `pnpm
pw:lint-tests` and the specific test file afterward — both should stay clean.

## Debugging a failing test

- `pnpm exec playwright show-report artifacts/playwright/runs/html-report` (or `pnpm pw:report`)
  opens the last run's HTML report, including named steps, screenshots, and traces.
- `pnpm exec playwright test --project=chromium --debug e2e/tests/<file>.spec.ts` (`pnpm
  pw:test:debug`) opens Playwright's Inspector for step-through debugging with a real browser
  window.
- `pnpm exec playwright test --ui` (`pnpm pw:test:ui`) opens the interactive UI mode, which is
  usually the fastest way to iterate on a single test locally.
- A failed test's console messages and failed network requests are attached automatically
  (redacted) via the `diagnostics` auto-fixture — check the HTML report's attachments before
  reaching for `console.log`.

## First-test tutorial: writing your very first Playwright test (Stage 10)

This walks a manual tester with no prior Playwright experience through writing one real, passing
test from nothing. It assumes the app is already runnable locally (`pnpm install`, a Postgres
database matching `.env`'s `DATABASE_URL`, `pnpm dev`).

1. **Read a reference test first.** Open `e2e/tests/guest-viewing.spec.ts` top to bottom — see
   **Walking through a reference test** above for exactly what to look for. Do not skip this; every
   step below assumes you recognize the shapes it establishes.
2. **Pick (or add) a requirement.** Every test declares which `quality/requirements.yaml` entry it
   covers, via `requirementIds`. Skim that file for one that matches what you're about to test; if
   none fits, see **Adding a new requirement** below before writing the test itself.
3. **Decide readonly or mutating.** Does your test only navigate/read (`@readonly`), or does it
   create/update/delete data (`@mutating`)? This single decision picks your fixture (`weddingData`
   for read-only setup via the fixtures in `e2e/fixtures/index.ts`, `managedWedding` for anything
   your test itself mutates) and one of your two required tags.
4. **Create the file.** Name it `e2e/tests/<feature>.spec.ts` (a new file) or add a case to an
   existing one if it's a close variant of what's already there (see **Extending an existing test
   vs. authoring a new one** in the pw-author-test skill for that judgment call). Copy the overall
   shape of whichever reference test matches your data-impact tag most closely — the
   `defineQualityTest({...}, ({ page, ... }) => {...})` wrapper, the metadata object, the
   Arrange/Act/Assert `test.step`s.
5. **Fill in the metadata object** — `id` (prefixed with your file's slug, e.g.
   `guest-export.download-produces-a-pdf`), `title`, `objective` (one sentence: what user-facing
   behavior does this protect?), `expectedOutcome` (one sentence: what does "it worked" look like?),
   `requirementIds` (from step 2), `tags` (data-impact + feature + suite + risk, at minimum — see
   the **Tagging cheat sheet** below for the full list).
6. **Write Arrange/Act/Assert as named `test.step`s.** Arrange sets up data (through a fixture or
   the real API, never the UI, unless the UI setup path IS what you're testing). Act performs the
   one behavior under test. Assert checks the outcome via `expect`/`expect.poll` against a page or
   component object method — never a raw `page.locator(...)` call in the test file itself (see
   **Enforcement** above for why, and what happens if you do).
7. **If the page doesn't have a method for what you need, add one** to `e2e/pages/` or
   `e2e/components/` first, following `WeddingGuestsPage.addGuest()`'s shape (constructor-injected
   `Page`/`Locator`, a business-readable method name, no test-specific logic leaking into the page
   object itself).
8. **Run it for real, repeatedly, before you trust it:**

   ```bash
   pnpm exec tsc --noEmit                                       # your new file must typecheck
   pnpm pw:lint-tests                                            # catches raw selectors, fixed waits, etc.
   pnpm exec playwright test --project=chromium e2e/tests/<your-file>.spec.ts
   pnpm exec playwright test --project=chromium e2e/tests/<your-file>.spec.ts --repeat-each=3
   ```

9. **Check the generated report** (`pnpm pw:report`) — confirm your named steps show up clearly and
   the pass/fail reasoning reads the way you'd explain it to a colleague.
10. **Run `pnpm pw:validate`** one more time before considering the test done — it re-checks
    typecheck, metadata, and lint together, the same gate CI runs.

## Tagging cheat sheet (Stage 10)

Every governed test needs at least the tags each dimension marked **required** below demands (an
`exactly-one` dimension needs precisely one of its tags; `at-least-one` needs one or more;
`optional` needs none unless it genuinely applies). `pnpm pw:validate-metadata` rejects a test
missing a required dimension, an unknown tag, or a combination `quality/tag-taxonomy.yaml` marks as
conflicting (e.g. `@quarantined` + `@suite:smoke`) — the full authoritative list always lives there;
this table is a quick-reference copy of it as of Stage 10, not a second source of truth.

| Dimension | Required? | Tags |
|---|---|---|
| data-impact | exactly one | `@readonly`, `@mutating` |
| feature | at least one | `@feature:authentication`, `@feature:guests`, `@feature:relationships`, `@feature:tables`, `@feature:seating-plan`, `@feature:manual-adjustment`, `@feature:day-of-mode`, `@feature:export`, `@feature:collaboration`, `@feature:rsvp`, `@feature:portfolio`, `@feature:timeline`, `@feature:templates`, `@feature:budget`, `@feature:mobile`, `@feature:non-functional`, `@feature:framework` |
| suite | at least one | `@suite:smoke`, `@suite:regression`, `@suite:framework` |
| risk | exactly one | `@risk:critical`, `@risk:high`, `@risk:normal`, `@risk:low` |
| role | optional | `@role:anonymous`, `@role:user`, `@role:administrator` |
| test-type | optional | `@visual`, `@accessibility`, `@external-service` |
| lifecycle | optional | `@quarantined` (requires an `annotation: [{ type: "quarantine-reason", ... }]`; conflicts with `@suite:smoke`) |

Common combinations, as real saved selections (`quality/saved-selections.yaml`, run via `pnpm
pw:run --selection <name>` or `pnpm pw:run:<name>`):

- `readonly` — `@readonly` (safe against any environment, including production with explicit
  approval).
- `smoke` — `@suite:smoke AND NOT @quarantined` (fast PR-gate subset).
- `regression` — `@suite:regression AND NOT @quarantined` (deeper coverage; what CI's E2E job runs
  today — see **CI, sharding, and report merging** below).
- `critical` — `@risk:critical` (every test protecting a critical-risk behavior, regardless of
  suite).

## Common commands (Stage 10)

A single consolidated reference — every command below is a real `package.json` script.

| Command | What it does |
|---|---|
| `pnpm pw:install` | Installs Playwright's Chromium binary. |
| `pnpm pw:list` | Lists every discoverable test (chromium + framework-unit projects) without running anything. |
| `pnpm pw:test` | Runs the full suite (application tests + framework unit tests). |
| `pnpm pw:test:headed` / `pnpm pw:test:debug` / `pnpm pw:test:ui` | Headed browser / step-through Inspector / interactive UI mode, for local debugging. |
| `pnpm pw:validate` | Typecheck + metadata validation + lint + a dry `--list` — the one command to run before considering any change done; matches CI's `validate` job. |
| `pnpm pw:validate-metadata` | Validates `quality/*.yaml` and every test's governed metadata against the schemas and tag taxonomy. |
| `pnpm pw:lint-tests` | Static authoring-standards checks (raw selectors, fixed waits, `.only`, unreasoned skips, swallowed catches, missing assertions). |
| `pnpm pw:run "<expr>"` / `pnpm pw:run --selection <name>` | The safe, tag-aware execution engine — production/mutation guard, preview, run manifest. |
| `pnpm pw:run:readonly` / `:smoke` / `:regression` / `:critical` | Shortcuts for the four saved selections. |
| `pnpm pw:report` / `pnpm pw:serve-report` | Opens/serves Playwright's own native HTML report for the last run. |
| `pnpm pw:report:run` | Serves the Stage 06 normalized run report (JSON + self-contained HTML) with working relative links. |
| `pnpm pw:review` / `pnpm pw:review:serve` | Regenerates / serves the Stage 07 suite review (coverage, value/quality scores, requirement traceability). |
| `pnpm pw:triage [--run-id <id>]` | Classifies a completed run's real failures against Section 10.4's 7 categories (Stage 09). |
| `pnpm pw:triage:serve` | Serves the maintenance/triage report. |
| `pnpm exec tsx playwright-framework/cli/ci-summary.ts` | Prints the CI pass/flaky/quarantined/zero-test summary for the most recent (or a named) run report; exits non-zero on a zero-test run (Stage 10). |
| `pnpm exec tsx playwright-framework/cli/print-ci-selection.ts <selection>` | Prints the `--grep` pattern + matched files for a saved selection, for CI's sharded invocation (Stage 10). |
| `pnpm exec tsc --noEmit` | Typechecks the whole framework + test suite (no build artifacts). |

## Report-review guide (Stage 10)

Three distinct report families exist; know which one answers your actual question before opening
one.

- **Run report** (`artifacts/playwright/runs/run-reports/<runId>.{json,html}`, `pnpm
  pw:report:run` to serve) — "what happened the last time the suite ran?" Per-test status (one of
  the 8 Section 10.2 categories — initial-pass, retry-pass, consistent-failure, timeout, skipped,
  expected-failure, quarantined, setup-failure), named Arrange/Act/Assert steps, why-passed/
  why-failed explanations, evidence attachments (screenshot/trace/console/network, all redacted).
  Start here for "did my change break anything, and specifically what."
- **Suite review** (`artifacts/playwright/runs/suite-reviews/<reviewId>.{json,html}`, `pnpm
  pw:review:serve`) — "how healthy and well-covered is the whole suite?" Requirement coverage
  (plain and risk-weighted), per-test value/quality scores (mechanical criteria calculated fresh;
  business-value criteria `provisional`/`needsHumanReview` until a human supplies them — see
  **Updating the value model** below), a review queue of anything needing human attention. Start
  here for "are we testing the right things, and how well."
- **Maintenance/triage report** (`artifacts/playwright/maintenance/<reportId>.{json,html}`, `pnpm
  pw:triage:serve`) — "why did this specific failure happen, and can it safely be repaired?" One
  of Section 10.4's 7 classifications per real failure, evidence for/against an application defect
  vs. a test defect, and a `repairAllowed` verdict `/pw-repair-test` and `repair-write-guard.mjs`
  both defer to. Start here before touching a failing test's own code.

Reading a report's status: every status is conveyed by symbol **and** text, never color alone
(accessibility — confirmed via a real WCAG contrast check in Stage 06's own audit). A run report
entry marked "flaky" (retry-pass) or a run summary showing `counts.retryPass > 0` is genuinely
different from a clean pass, even though Playwright's own exit code treats both as success — see
**CI, sharding, and report merging** below for exactly how CI surfaces that difference.

## Good and bad examples (Stage 10)

| Instead of… | Do this | Why |
|---|---|---|
| `await page.locator(".guest-row").first().click()` in a test | `await guestsPage.guestRow(name).edit()` (a page/component object method) | A raw selector in a test file breaks `pw:lint-tests`'s `raw-selector-in-test` rule and couples every test to the DOM directly — one real markup change breaks every test that touched it, instead of one page-object method. |
| `await page.waitForTimeout(2000)` | `await expect(locator).toBeVisible()` / `await expect.poll(...)` | A fixed wait is either too short (flaky) or too long (slow) by construction; Playwright's own auto-waiting assertions retry until the real condition is true or a real timeout elapses. Flagged by `pw:lint-tests`'s `fixed-wait` rule. |
| `test.skip()` with no comment | `test.skip(true, "TS-42: blocked on FR-9.2 shipping")` or a `// pw-lint-exception: ... -- <rationale>` | An unreasoned skip is invisible technical debt; a reasoned one is a documented, reviewable decision. Flagged by `pw:lint-tests`'s `unreasoned-skip` rule. |
| `try { ... } catch { /* ignore */ }` around a real assertion | Let it throw, or `catch` only to attach diagnostic evidence before re-throwing | A swallowed error can hide a real failure behind a false green pass. Flagged by `pw:lint-tests`'s `swallowed-error` rule. |
| One test asserting five unrelated outcomes on one page | One test per distinct behavior/failure mode (see **Extending an existing test vs. authoring a new one**, `pw-author-test` skill) | A test with several unrelated assertions doesn't tell you WHICH thing broke when it fails, and inflates independence/traceability scoring without adding real coverage. |
| A test that reaches into another test's data | Each test creates its own account/wedding via `account`/`weddingData`/`managedWedding` fixtures | Shared mutable state is exactly what breaks parallel execution and order-independence — see **Test isolation and reliability** above. |

## Manual-test-to-automation worksheet (Stage 10)

A fillable template for turning an existing manual test case into this framework's structure lives
at `quality/manual-test-to-automation-worksheet.md`. Copy it, fill in each field for the manual case
you're automating, and the filled-in worksheet maps directly onto a `defineQualityTest(...)` call's
metadata plus its Arrange/Act/Assert steps — see the **First-test tutorial** above for what happens
next.

## Adding requirements, features, tags, page objects, fixtures, and test data (Stage 10)

- **A new requirement**: add an entry to `quality/requirements.yaml` (id, title, ticket reference if
  one exists, `status: needs-human-review` — never `confirmed` until a human actually reviews it;
  see DEC-009). Run `pnpm pw:validate-metadata` to confirm it parses.
- **A new feature tag**: add it under the `feature` dimension in `quality/tag-taxonomy.yaml` (name,
  description). Feature tags are deliberately open-ended — add one whenever a genuinely new area of
  the product needs its own tag, rather than overloading an existing one.
- **A new tag in another dimension** (risk/role/etc.): same file, same shape; check
  `requirement`/conflicts first — adding a tag to an `exactly-one` dimension changes what every
  existing test in that dimension must now choose between.
- **A new page object**: add a class to `e2e/pages/` (or a component to `e2e/components/` for a
  reusable sub-element like a table row), constructor-injected `Page`/`Locator` only, no module-level
  mutable state, business-readable method names (`addGuest`, not `clickButton3`). See
  `WeddingGuestsPage`/`GuestRow` for the established shape.
- **A new fixture**: add it to `e2e/fixtures/index.ts`, composing the existing `account` →
  `weddingData` → `managedWedding` chain rather than reinventing setup/teardown — see **Test
  isolation and reliability** above for why cleanup failures are attached as warnings, never thrown.
- **New test data**: use `e2e/data/ids.ts`'s `uniquePersonName()`/`uniqueTitle()` helpers for
  worker-safe unique values — never hardcode a name/title a parallel run could collide on. If a new
  field needs its own uniqueness scheme (a new app-side pattern constraint discovered live, the way
  `PERSON_NAME_PATTERN`/`WEDDING_NAME_PATTERN` were), add a new helper there rather than ad hoc
  string-building inside a test.

## Updating the value model and approving overrides (Stage 10)

The value/quality rubric lives in `quality/test-value-model.yaml` (weights must total 100 per
category, schema-enforced) with a generated, human-readable `quality/test-value-model.md` — run
`pnpm pw:generate-value-model-md` after any change to the `.yaml` to keep them in sync (checked by
`pw:validate`'s own drift detection). Changing a criterion's weight or description is a real
decision about what this framework considers valuable — treat it like any other reviewed change,
not a quick edit.

A **human override** of a calculated score (Section 8.6) goes in `quality/value-overrides.yaml` —
never written by the framework itself. Each entry needs `overrideType` (`total-score` or
`criterion-score`, the latter also needs `criterionId`), the new score, an `approver`, a `date`, and
a `rationale` explaining why the calculated result was wrong or incomplete. `applyOverride.ts`
always preserves the original calculated criteria alongside the override for comparison — an
override never silently erases the mechanical result it's replacing.

## Report retention, cleanup, and disk-usage expectations (Stage 10)

Locally, every generated report/artifact lives under `artifacts/playwright/` (gitignored in full —
see `.gitignore` — only `.gitkeep` placeholders and the framework source that PRODUCES these
artifacts are ever committed). Nothing here needs manual cleanup for correctness — every CLI writes
a new, uniquely-`runId`/`reportId`-named file rather than overwriting previous runs — but the
directory grows unbounded over time with real use (traces and videos are the largest contributors).
`rm -rf artifacts/playwright/runs/test-results/*` (or the whole `artifacts/playwright/` tree, since
nothing there is source) is always safe to run locally when disk space matters; nothing outside that
directory depends on old report content persisting.

In CI, every workflow (`.github/workflows/{ci,scheduled-regression,weekly-quality-review}.yml`)
uploads its reports via `actions/upload-artifact` with an explicit `retention-days` (14 days for the
PR gate and nightly regression, 30 days for the weekly quality review's suite-review/maintenance
artifacts, since those are meant to show trend/drift over a longer window). These are defaults, not
a considered policy — a human should confirm the actual desired retention window for this
repository/organization (GitHub's own maximum is 90 days) and adjust the `retention-days` values
directly in each workflow file; nothing else depends on the current numbers.

## CI, sharding, and report merging (Stage 10)

Three workflows live under `.github/workflows/`:

- **`ci.yml`** — runs on every push/PR to `main`. A `validate` job (typecheck, metadata validation,
  lint, framework unit tests — no database, and almost no browser, but a handful of framework-unit
  specs render HTML reports against a real Chromium DOM and need one installed; see TS-56) gates a
  separate `e2e` job (the real application suite, sharded across 2 shards against a real Postgres
  service container and a real built-and-started Next.js app), followed by a `merge-reports` job
  that combines both shards' blob reports into one native HTML report.
- **`scheduled-regression.yml`** — the same regression selection, nightly, independent of push/PR
  activity (catches drift on a quiet day — an environment change, a dependency update).
- **`weekly-quality-review.yml`** — optional/best-effort: re-runs the regression selection with
  `--repeat-each=3` to proactively surface newly-flaky tests, then regenerates the suite review
  (`pnpm pw:review`) on a fixed weekly cadence.

**Why the E2E job doesn't use `pnpm pw:run`.** `pw:run`'s `--reporter` flag forwards a single
Playwright-native reporter name that REPLACES the whole configured reporter array (a Stage 06
finding, still true), and it has no `--shard` support at all. Using it for CI's sharded run would
silence the Stage 06/09 normalized reporter `ci-summary.ts` and `pw:triage` both depend on. Instead,
`playwright-framework/cli/print-ci-selection.ts` (a new, narrowly-scoped, read-only Stage 10 script)
computes the exact same `--grep` pattern and matched spec files `pw:run --selection regression
--list` would show — reusing the identical `evaluateExpression`/`compileToGrepPattern` primitives,
so CI's real invocation can never silently drift from what a human previewing the same selection
locally would see — and the workflow spawns `playwright test` directly with that plus `--shard` and
a real `blob,<normalizedReporter path>` multi-reporter list. This intentionally bypasses `pw:run`'s
own production/mutation preflight; DEC-018 already discloses this exact bypass for any bare
`playwright test --grep` invocation, and it is a no-op here regardless since `PRODUCTION_HOSTNAMES`
is always empty in this repository (DEC-005 — there is no real production deployment). **`pw:run`
remains the only way to safely run a selection against a real, configured production host** — never
adapt this CI pattern for that case.

**CI secrets and scoping.** The E2E job needs `DATABASE_URL` (points at an ephemeral, job-lifetime-
only `postgres:16` service container — never a secret, since the container and its data cease to
exist the moment the job ends) and `JWT_SECRET`/`ENCRYPTION_KEY` (generated fresh per run via
`openssl rand -hex 32`, written to `$GITHUB_ENV`, never echoed to the log or persisted anywhere).
None of these gate anything real, so none are stored as GitHub repository secrets — the baseline
gate needs zero configured secrets. `RESEND_API_KEY` is deliberately left unset in CI, falling back
to the app's own console-log stand-in for email (see `.env.example`'s own comment) rather than
wiring a real email provider into CI.

**Branch/PR status behavior for failed, flaky, quarantined, and zero-test runs** — the acceptance
criterion this framework had to actually go verify, not assume: `pnpm exec playwright test -g
"<pattern that matches nothing>"` and `--shard=N/M` with an empty shard both print "No tests found"/
nothing alarming but **exit 0** (verified live during Stage 10's implementation) — Playwright still
writes a normalized run report for either case, with every count at zero, indistinguishable at a
glance from a report worth calling a clean pass. `playwright-framework/cli/ci-summary.ts` (run as a
dedicated `if: always()` step right after every real Playwright invocation in all three workflows)
is the mechanical fix: it reads that run report and (1) exits non-zero on a genuine zero-test run —
the one case this script actually overrides Playwright's own exit code for — (2) writes a
`$GITHUB_STEP_SUMMARY` table and emits a `::warning::` annotation for any flaky (retry-pass) result,
so a pass that only succeeded after a retry is never visually identical to an ordinary clean pass on
the PR checks list, and (3) does the same for any quarantined test that actually executed (normally
excluded from `smoke`/`regression` by tag conflict, so seeing one at all is worth a human's
attention). A real, ordinary failure doesn't need this script to fail the job — Playwright's own
exit code already does that; `ci-summary.ts`'s job is strictly the visibility Playwright's exit code
alone doesn't provide.

## Framework upgrade and compatibility checks (Stage 10)

Before bumping `@playwright/test`, Node, or `pnpm`'s pinned version (`packageManager` in
`package.json`):

1. Read the new version's changelog for anything affecting reporter APIs, tag/annotation handling,
   or sharding/blob-report behavior — this framework's own custom reporter
   (`normalizedReporter.ts`), tag-expression compiler, and CI sharding all depend on specific,
   documented Playwright behavior that a major version could change.
2. Bump the version, reinstall (`pnpm install`), and re-run the FULL validation sequence before
   trusting anything: `pnpm exec tsc --noEmit`, `pnpm pw:validate`, `pnpm pw:test` (all framework
   unit tests, including every hook test under `playwright-framework/tests/hooks/`), then a real
   `pnpm exec playwright test --project=chromium` run against a live app.
3. Re-verify the CI-specific mechanisms live, the same way Stage 10 originally did: a real
   zero-match `--grep` still needs to exit non-zero from `ci-summary.ts` even if Playwright's own
   exit-0-on-no-tests behavior ever changes upstream; a real sharded run (`--shard=1/2` and
   `--shard=2/2`) still needs to produce mergeable blob reports (`playwright merge-reports`).
4. Bump `playwright-framework/version.ts`'s `FRAMEWORK_VERSION` only once every check above is
   green — it is this framework's own compatibility marker embedded in every run report/suite
   review/maintenance report, not Playwright's version (already tracked separately as
   `RunReport.playwrightVersion`).
5. If the upgrade changes any documented command's behavior, update the specific section of this
   guide (and `README.md`) that describes it in the same change — never let this document silently
   drift out of sync with what the pinned versions actually do.
