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
