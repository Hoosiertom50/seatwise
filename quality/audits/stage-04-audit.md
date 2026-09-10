# Stage 04 Audit

Result: PASS WITH FINDINGS (one finding required a fix before this PASS was recorded; see "Corrections made")
Auditor: Independent review subagent, fresh context with no memory of the implementation work, instructed to run real commands and probe the code adversarially rather than trust the implementation log's prose.
Date/time: 2026-09-10
Repository is not under git version control in this sandbox (`git` unavailable / not a repo); no commit hash to record. All files below were read directly from the working tree.

## Scope

Verify Stage 04 (test-authoring standards, enforcement, and reference tests) against `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` Section 7.2–7.4, the Stage 04 task list, acceptance criteria, and audit gate under Section 4/12, DEC-013/DEC-014, and the precedent set by `quality/audits/stage-03-audit.md`. Every file listed in the audit brief was read in full; commands were executed directly rather than trusted from the implementation log. The audit gate's own instruction — "Have the reviewer explain each reference test's objective without reading its page-object implementation first" — was followed literally: `guest-viewing.spec.ts` and `guest-management.spec.ts` were read cold, my conclusions were recorded, and only afterward were `WeddingGuestsPage`/`GuestRow`/fixtures read to check the cold reading against the truth.

## Files reviewed

- `PLAYWRIGHT_TESTING.md` (in full)
- `e2e/tests/guest-viewing.spec.ts`, `e2e/tests/guest-management.spec.ts` (cold-read first, then re-read after page objects)
- `e2e/pages/WeddingGuestsPage.ts`, `e2e/components/GuestRow.ts`, `e2e/fixtures/index.ts`, `e2e/data/api.ts`, `e2e/support/evidence.ts`
- `playwright-framework/validation/lintRules.ts`, `playwright-framework/validation/discoverTestMetadata.ts` (in full)
- `playwright-framework/cli/lint-tests.ts` (in full)
- `playwright-framework/metadata/validateMetadata.ts` and `playwright-framework/tests/validateMetadata.spec.ts` (stale-requirement test case)
- `playwright-framework/tests/lintRules.spec.ts`, `playwright-framework/tests/discoverTestMetadata.spec.ts`, `playwright-framework/tests/fixtures/badPatternSnippets.ts`
- `e2e/tests/framework-health.spec.ts` (the one documented lint exception)
- `quality/requirements.yaml`, `package.json`
- `quality/audits/stage-03-audit.md` (format/rigor precedent)

## Cold-read exercise (audit gate requirement)

**Before opening any page object**, reading `e2e/tests/guest-viewing.spec.ts` alone, my conclusion was:

- **Checking:** a signed-in planner can view a guest that already exists on their wedding's guest list — a pure read scenario.
- **Arranges:** creates the guest ahead of time through the real API (`weddingData.createGuest`), not through the UI — explicitly so the test's own action stays read-only.
- **The one action under test:** navigate to the wedding page and open the Guests tab (a read, not a write).
- **How it knows it worked:** locates the guest's row by full name and polls `firstName()`/`lastName()`/`rsvpStatus()` to equal the expected values (`"PENDING"` by default), plus a `.expectVisible()` check.

Same exercise on `e2e/tests/guest-management.spec.ts`:

- **Checking:** a signed-in planner can add a guest through the UI and see it appear in the guest list — a mutating scenario.
- **Arranges:** opens the wedding's Guests tab and generates a unique person name.
- **The one action under test:** submit the add-guest form (`weddingGuestsPage.addGuest(...)`).
- **How it knows it worked:** locates the new guest's row by name, asserts visibility, and polls `firstName()`/`lastName()`/`rsvpStatus()` against the expected values.

**Confirmed accurate after reading the page objects.** `WeddingGuestsPage`/`GuestRow` implement exactly what the test files' own step names and metadata (`objective`/`expectedOutcome`) claimed — no surprises, no selector mechanics that would have changed my answer. This is a genuine, non-rubber-stamped pass of the acceptance criterion "A manual tester can follow the guide to understand and modify a reference test": both tests read as business intent, and `PLAYWRIGHT_TESTING.md`'s own "Walking through a reference test" section asks the reader the exact four questions I answered above, unprompted, before I'd read that section closely — the guide's claim about itself held up.

## Commands executed and results

- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` → `200`; `ps aux | grep -E "postgres|next"` → Postgres 16 and `next dev` (v16.3.4) already running. No environment setup needed.
- `pnpm exec tsc --noEmit` → exit 0, zero errors (both before and after the fix described below).
- `pnpm pw:lint-tests` → **exactly matches the implementation log's claim**: `1 item(s) noted for human review` (the `framework-health.spec.ts` exception), `Lint OK: 3 test file(s), 2 discovered test(s), 0 hard failures.`
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=... pnpm pw:test` → **127/127 passed** before this audit's fix, **129/129** after (2 new locking tests added — see Corrections made).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=... playwright test --project=chromium e2e/tests/guest-management.spec.ts e2e/tests/guest-viewing.spec.ts --reporter=list` → **2/2 passed**, both live against the real app.
- **Independently re-run parallel/repeat** (not trusted from the log): `--repeat-each=2 --workers=3` → **4/4 passed**, zero collisions.
- **Independently re-run swapped order as separate process invocations**: `guest-viewing.spec.ts` alone → 1/1 passed; `guest-management.spec.ts` alone (run second) → 1/1 passed. Both pass regardless of which ran "first" in this session, confirming no shared state between them.
- **Adversarial lint probing** (own snippets, not `badPatternSnippets.ts`): a throwaway script called `checkTestSource` directly with 13 representative snippets covering every rule, including deliberately hostile variants (destructure-renamed `page`, local aliases, helper-function indirection, multi-test files). This is what surfaced the High finding below.
- **Live CLI-breaking test** (temporary scratch files inside `e2e/tests/`, deleted immediately after each check, confirmed via `ls e2e/tests/` that the tree was restored):
  - A scratch file with `test.only(...)` + a raw `page.locator(...)` call → `pnpm pw:lint-tests` correctly reported both `[test-only]` and `[raw-selector-in-test]` and **exited 1**.
  - A scratch file with a `defineQualityTest` id not prefixed by its filename slug → `pnpm pw:lint-tests` correctly reported `[naming-convention]` and **exited 1**.
- Every real spec file's test ID was checked against its file slug: `guest-management.spec.ts` → `guest-management.add-guest-appears-in-list` ✓; `guest-viewing.spec.ts` → `guest-viewing.guest-list-shows-existing-guests` ✓; `framework-health.spec.ts` uses raw `test(...)`, not `defineQualityTest`, so the naming-convention check (which only fires on discovered `defineQualityTest` calls) correctly does not apply to it.
- **Stale-metadata unit test** (`validateMetadata.spec.ts:106-126`) read directly: confirms a requirement whose `status` is `"retired"` is reported with a message containing both `"retired requirement"` and `"stale metadata"`, and explicitly asserts the SAME issue does **not** also contain `"unknown requirement"` — the two checks are mutually exclusive (`validateAllTestMetadata`'s `if (!requirementIds.has(reqId)) {...} else if (retiredRequirementIds.has(reqId)) {...}` is an `if`/`else if`, structurally incapable of double-counting). No requirement in the real `quality/requirements.yaml` is currently `status: retired`, so this path is exercised only by the unit test today — correctly so, since nothing here should retire a real requirement on the audit's own authority.

## Acceptance criteria evidence

- **"A manual tester can follow the guide to understand and modify a reference test."** Confirmed by direct exercise, not by reading the guide's own claim about itself — see "Cold-read exercise" above. `PLAYWRIGHT_TESTING.md` also covers authoring, debugging (`pw:test:debug`, `pw:test:ui`, `pw:report`), metadata/tags, evidence, and review guidance (the exception mechanism's "noted for human review" framing) in full, matching the Stage 04 task list line for line.
- **"Bad-pattern fixtures are detected by automated validation."** Confirmed: `lintRules.spec.ts` feeds every constant in `badPatternSnippets.ts` through `checkTestSource` and asserts the expected rule fires (and that `CLEAN_TEST` and the two real reference tests produce zero issues) — re-verified live via `pnpm pw:test`. Adversarial probing beyond the shipped fixtures found one real gap (see Findings).
- **"Reference tests pass individually, in reverse selection order, in parallel, and through configured repeat execution."** All four re-confirmed live by this audit (not re-trusted from the log) — see Commands above.
- **"Test source reads primarily as business intent rather than selector mechanics."** Confirmed: neither reference test contains a single `page.`/`context.`/`frame.` call; every action goes through `weddingGuestsPage`/`weddingData`/`evidence`. `pnpm pw:lint-tests` independently confirms this for the whole real suite (0 hard failures), not just for these two files by inspection.

## Findings

### Critical

None.

### High

- **The `raw-selector-in-test`, `raw-screenshot-in-test`, and `fixed-wait` rules matched only the literal identifiers `page`/`context`/`frame` as the receiver — trivially and silently bypassed by the single most ordinary way a Playwright test author renames one of these, not an exotic evasion.** `playwright-framework/validation/lintRules.ts` (pre-fix): `const RECEIVER_NAMES = new Set(["page", "context", "frame"]);`, checked via `RECEIVER_NAMES.has(receiver.text)` where `receiver` is whatever identifier text sits to the left of the dot. A destructure-rename of the fixture parameter — `async ({ page: p }) => { await p.locator(...).click(); }`, a completely mundane pattern the moment a test needs a second differently-scoped page (`{ page: adminPage }`, `{ page: guestPage }`) — or even a plain local alias (`const thePage = page;`) made every raw selector/screenshot/fixed-wait call on that variable invisible to all three rules. Reproduced directly against the pre-fix code:
  ```ts
  test("renamed page var", async ({ page: p }) => {
    await p.locator("#foo").click();   // raw-selector-in-test: NOT detected (pre-fix)
    expect(1).toBe(1);
  });
  ```
  ```ts
  test("aliased const", async ({ page }) => {
    const thePage = page;
    await thePage.locator("#foo").click();   // raw-selector-in-test: NOT detected (pre-fix)
    expect(1).toBe(1);
  });
  ```
  Same result for `p.screenshot(...)` (`raw-screenshot-in-test`) and `p.waitForTimeout(...)` (`fixed-wait`) under the renamed-parameter form. This directly contradicts the Stage 04 acceptance criterion "Bad-pattern fixtures are detected by automated validation" and spec Section 7.2/7.3's substantive requirement (not just the shipped fixture set, which never exercised a rename) — a test author does not need to be adversarial to defeat the framework's primary enforcement mechanism for its two most-cited rules; a routine multi-page test would do it by accident. Severity High because this is the core static-analysis deliverable of the entire stage, the bypass requires zero special effort, and the current reference tests happen not to trigger it only because neither one destructures `page` directly (both go through fixture-provided page objects) — the gap is real and live for any future test that does. **Fixed during this audit — see Corrections made.**

### Medium

- **The `swallowed-error` heuristic can produce a false positive when a `catch` block delegates to a helper function that itself always rethrows, since the checker only looks for a literal `throw`/`attach`/`expect` call *textually inside* the catch block, not through a called function's own body.** Reproduced:
  ```ts
  function rethrowWrapped(e: unknown): never {
    throw new Error("wrapped: " + String(e));
  }
  test("catch calls throwing helper", async ({ page }) => {
    try { await page.goto("/"); }
    catch (e) { rethrowWrapped(e); }   // flagged swallowed-error even though this never returns
    expect(1).toBe(1);
  });
  ```
  This is directionally safe (over-strict, not permissive — it never lets a truly swallowed error through) but is a real usability gap: a legitimate "extract the rethrow into a shared helper" refactor would be blocked by lint and would need a `pw-lint-exception` comment to pass, even though nothing is actually wrong. Not fixed — closing it properly would require either real call-graph analysis (out of proportion to a lightweight AST linter) or a narrower fix (e.g., trusting a helper whose declared return type is `never`), which is a reasonable follow-up but not a blocking gap since the one-line exception mechanism (DEC-014) already exists specifically for cases like this.
- **The same heuristic can also produce a false negative when the catch block calls a *locally-declared* function literally named `attach` or (via shadowing) `expect` that does nothing meaningful** — the regex `/\battach\b/i` / `/^expect\b/` / `/\.expect\b/` matches on call-site *text* only, with no check that the callee actually resolves to `testInfo.attach`/Playwright's `expect`. Reproduced:
  ```ts
  function attach(e: unknown): void { /* does nothing real */ }
  test("catch calls noop attach", async ({ page }) => {
    try { await page.goto("/"); }
    catch (e) { attach(e); }   // NOT flagged — genuinely swallowed, but the name alone satisfies the heuristic
    expect(1).toBe(1);
  });
  ```
  This requires a fairly deliberate (and confusing) naming choice — shadowing `attach`/`expect` with an unrelated local helper — so the realistic likelihood of this being hit by accident is low, and no real test file in this repo does anything like it (confirmed: neither reference test declares any local function named `attach` or `expect`). Not fixed; recorded as a known heuristic limitation for a future stage that wants stronger call-graph awareness.

### Low

- **`missing-assertion` only recognizes bare `test(...)` and `defineQualityTest(...)` calls as "test cases" (via the regex `/(^|\.)test$/` on the callee text), not `test.only(...)`, `test.skip(...)`, `test.fixme(...)`, or `test.fail(...)` forms** — a `test.only(...)`/`test.skip(...)` body with zero `expect(...)` calls will not be separately flagged by `missing-assertion` (though `test.only` is of course still caught by the `test-only` rule itself, and an unreasoned `test.skip` by `unreasoned-skip`). Low impact since the other rule already blocks the commit path for `test.only`, and a skipped test's assertions not running is a lesser concern than a live test's; noted for completeness rather than as something requiring a fix.
- **A `test.step` callback with zero assertions is not separately flagged when the enclosing test has assertions elsewhere** (confirmed via probe: a step containing only `await Promise.resolve()` produces no issue as long as the test as a whole has at least one `expect(...)`). This matches spec Section 7.3's literal wording ("fail when its central business validation is not executed" is a whole-test requirement, not stated per-step), so this is not a violation of the stated acceptance criteria — flagging it purely as a design note: a step that silently does nothing would undercut the AAA narrative `PLAYWRIGHT_TESTING.md` itself champions, so a human reviewer, not the linter, is still the backstop for a step that promises "Assert: ..." in its name but asserts nothing.
- **`e2e/tests/framework-health.spec.ts`'s single `pw-lint-exception` comment is the only exception in use anywhere in the real suite**, confirmed real and correctly disclosed (not a workaround for a genuine app-selector gap) — carried forward from Stage 03/04's own design, not a new issue.

## Corrections made

**The High finding (receiver-alias bypass) was fixed during this audit.** `playwright-framework/validation/lintRules.ts` gained a `collectReceiverAliases(sourceFile)` pre-pass that resolves local identifiers bound to `page`/`context`/`frame` via (a) destructure-renamed function parameters (`{ page: p }`) and (b) direct local variable assignment (`const thePage = page;`), iterating to a fixed point so short alias chains (`const p = page; const q = p;`) also resolve. The three receiver checks (`raw-selector-in-test`, `raw-screenshot-in-test`, `fixed-wait`) now test membership in this resolved alias set instead of the fixed three-name set. Re-verified against all four adversarial reproductions above — all now caught with the correct renamed identifier reported in the message (e.g. `Raw "p.locator(...)" call...`, `Raw "thePage.locator(...)" call...`).

Two locking regression tests/fixtures were added:
- `playwright-framework/tests/fixtures/badPatternSnippets.ts`: `RAW_SELECTOR_VIA_RENAMED_PAGE` (destructure-rename form) and `RAW_SELECTOR_VIA_LOCAL_ALIAS` (local-variable-alias form).
- `playwright-framework/tests/lintRules.spec.ts`: two new test cases asserting `raw-selector-in-test` is still caught in both forms.

Re-ran after the fix: `pnpm exec tsc --noEmit` clean; `pnpm pw:lint-tests` unchanged (`Lint OK: 3 test file(s), 2 discovered test(s), 0 hard failures` — the fix introduces no false positive against the real suite); `pnpm pw:test` → **129/129 passed** (127 + 2 new locking tests). The two Medium findings and three Low findings were **not** fixed — see their own entries for why (directionally safe / narrow attack surface / not a violation of the literal spec wording), consistent with `stage-03-audit.md`'s precedent of fixing what's High-or-above live and disclosing the rest for human decision.

## Remaining risks and human decisions

- The `swallowed-error` false-positive (Medium) means a legitimate "rethrow via shared helper" pattern will need a `pw-lint-exception` comment until/unless a future stage adds narrower call-graph awareness (e.g., trusting a callee whose declared return type is `never`). Not currently blocking anything real in this repo.
- The `swallowed-error` false-negative via a helper literally named `attach`/`expect` (Medium) is a known, narrow heuristic limitation — worth closing before this linter is trusted as a hard gate in a larger codebase with more contributors, but no real file here does this today.
- The `missing-assertion` scoping gap for `test.only`/`test.skip`/`test.fixme`/`test.fail` forms (Low) is disclosed but not fixed; low practical impact since `test-only`/`unreasoned-skip` already gate the more important cases.
- BLK-001 (GitHub session-repo-authorization gate blocking `git push`/PR creation) remains open and unrelated to this audit's scope; this sandbox is also not a git repository at all, so no commit was made — the fix above lives directly in the working tree.

## Final verdict

**PASS.** Both reference tests were independently cold-read — their objective, arrange step, act step, and assert step were all correctly inferable from the test file alone, before any page object was opened, directly satisfying the audit gate's own instruction and the stage's central acceptance criterion. `PLAYWRIGHT_TESTING.md` is comprehensive and its own "walking through a reference test" exercise held up under direct trial, not just inspection. `pnpm exec tsc --noEmit` is clean, `pnpm pw:lint-tests` output matches the implementation log's claim exactly (1 exception noted, 3 files, 2 discovered tests, 0 hard failures), and `pnpm pw:test` is 129/129 (127 pre-fix + 2 new locking tests). Both reference tests were independently re-verified — not re-trusted from the log — individually, together, under `--repeat-each=2 --workers=3`, and as separate process invocations in swapped order, all live against the real running app. The stale-metadata check is structurally correct and provably distinct from the "unknown requirement" check (mutually exclusive `if`/`else if`, confirmed by its own unit test). Adversarial probing beyond the shipped `badPatternSnippets.ts` fixtures found and fixed one real High-severity gap live during this audit — the three receiver-based static rules were trivially bypassed by the ordinary act of destructure-renaming or locally aliasing `page`/`context`/`frame`, not by anything adversarial — with two new locking regression tests added and the fix verified to introduce zero false positives against the real suite. Two Medium and three Low findings were identified, disclosed, and deliberately left open (documented false-positive/false-negative edges in the `swallowed-error` heuristic, and narrow completeness gaps that don't contradict the spec's literal wording). Stage 04 may be marked complete on the Progress Dashboard.
