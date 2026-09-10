# Stage 03 Audit

Result: PASS WITH FINDINGS (two findings required a fix before this PASS was recorded; see "Corrections made")
Auditor: Independent review subagent, fresh context with no memory of the implementation work, instructed to run real commands and probe the code adversarially rather than trust the implementation log's prose.
Date/time: 2026-09-10
Git commit at start of review: `b1528c5` (Stage 02 audit, on `main`); Stage 03 files are new/uncommitted at review time (`git status --short` showed 16 untracked/modified paths, listed below) — consistent with the spec's stage-gate order (audit before commit).

## Scope

Verify Stage 03 (page objects, fixtures, test data, and evidence architecture) against `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` Section 7.2–7.4, the Stage 03 task list, acceptance criteria, and audit gate under Section 12, and DEC-012/BLK-001 in Section 4. Every file listed in the audit brief was read in full; commands were executed directly rather than trusted from the implementation log.

## Files reviewed

- `e2e/pages/{BasePage,LoginPage,SignupPage,WeddingGuestsPage}.ts`, `e2e/components/GuestRow.ts`
- `e2e/fixtures/index.ts`
- `e2e/data/{ids,api}.ts`
- `e2e/support/{auth,redaction,artifactPaths,evidence}.ts`
- `e2e/tests/guest-management.spec.ts`, `e2e/tests/unit/{ids,redaction,artifactPaths}.spec.ts`
- `playwright-framework/metadata/defineQualityTest.ts` (generalized `createDefineQualityTest`)
- `packages/shared/src/validation.ts` (`PERSON_NAME_PATTERN`, `WEDDING_NAME_PATTERN`) — cross-checked against `e2e/data/ids.ts`'s claims
- `apps/web/src/app/weddings/[weddingId]/components/GuestsTab.tsx`, `apps/web/src/app/weddings/[weddingId]/page.tsx`, `apps/web/src/app/login/page.tsx`, `apps/web/src/app/signup/page.tsx` — cross-checked against every selector the page/component objects claim
- `quality/audits/stage-02-audit.md` (format/rigor precedent), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` Sections 4, 7, 12 ("Stage 03"), DEC-012, BLK-001
- `package.json`, `git log`/`git status`/`git diff --stat`

## Commands executed and results

- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` → `200`; `ps aux | grep -E "postgres|next"` → Postgres 16 and `next dev` (v16.3.4) both already running. No environment setup was needed.
- `pnpm exec tsc --noEmit` → exit 0, zero errors.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium pnpm pw:test` → **105/105 passed** (72 carried over from Stage 02 + 1 live chromium reference test + 32 new Stage 03 unit tests), matching the implementation log's claimed count exactly.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium pnpm exec playwright test --project=chromium e2e/tests/guest-management.spec.ts --reporter=list` → **1/1 passed** (2.4–3.4s), a real run against the live app (real signup, real wedding creation, real guest add, real DOM assertions), not a mock.
- **Independent re-confirmation of worker-safety** (not just trusting the prior run): `... --repeat-each=3 --workers=3` → **3/3 passed**, three concurrent workers each signing up their own account, creating their own wedding, and adding their own guest, with zero collisions or flakiness.
- `git log --oneline -5` / `git status --short` → Stage 03's files are new and uncommitted (`e2e/{components,data,fixtures,pages,support,tests}/*` untracked; `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` and `playwright-framework/metadata/defineQualityTest.ts` modified). `git diff --stat -- apps/ packages/` → empty; no application code touched.
- **Selector cross-check against real app source** (not trusted from comments): every selector claimed by the page/component objects was grepped/read directly in the app:
  - `LoginPage`: `#login-email`, `#login-password` ↔ `apps/web/src/app/login/page.tsx:41,54` — exact match. Error paragraph `p.text-red-600` ↔ `page.tsx:62` (`<p className="text-sm text-red-600 ...">`) — real, but genuinely a CSS-class fallback (no `id`/`data-testid`), honestly disclosed in the page object's own comment.
  - `SignupPage`: `#signup-name`, `#signup-email`, `#signup-password` ↔ `apps/web/src/app/signup/page.tsx:42,54,67` — exact match.
  - `WeddingGuestsPage`: `#guest-first-name`, `#guest-last-name`, `#guest-party-name`, `#guest-email` ↔ `GuestsTab.tsx:503,516,529,541` — exact match. "Guests" tab button ↔ `apps/web/src/app/weddings/[weddingId]/page.tsx:33` (`{ value: "guests", label: "Guests" }`) rendered as a plain `<button>{t.label}</button>` at line 211–221 — `getByRole("button", { name: "Guests", exact: true })` correctly resolves via the button's text-content accessible name.
  - `GuestRow`: `aria-label="First name for ${firstName} ${lastName}"`, `"Last name for ..."`, `"RSVP status for ..."`, `"Side for ..."` ↔ `GuestsTab.tsx:877,884,962,974` — exact match, not fabricated. The doc comment's claim that a `canEdit` guest's name renders as an `<input defaultValue>` (not text) is also confirmed at lines 876–890.
- **`PERSON_NAME_PATTERN` cross-check**: `packages/shared/src/validation.ts:13` → `/^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u` — confirmed no digit is permitted, matching `ids.ts`'s claim exactly. `WEDDING_NAME_PATTERN` (line 20) does allow `\p{N}` (digits), also matching the claim that `uniqueTitle` may embed one directly.
- **Adversarial redaction probing** (own values, not the shipped test file's): wrote a throwaway script (`e2e/tests/unit/_adversarial_redact_probe.ts`, deleted after use) that called `redact()` directly with representative values not in `redaction.spec.ts`. Full input/output pairs are in the Findings section below. This is what surfaced the two real findings below — the shipped unit-test suite (11 tests, all passing) does not cover either case.

## Acceptance criteria evidence

- **"A test can request page objects, data helpers, and evidence through typed fixtures."** Directly confirmed: `e2e/tests/guest-management.spec.ts` requests `managedWedding`, `weddingGuestsPage`, and `evidence` purely through `defineQualityTest`'s fixture-bound `test` (`e2e/fixtures/index.ts`), and the live run above proves the whole chain (`account → weddingData → managedWedding`, `page → weddingGuestsPage`, `evidence.checkpoint(...)`) actually executes end to end against the real app, not just type-checks.
- **"Parallel executions do not collide on data or artifact filenames."** Confirmed live via the independent `--repeat-each=3 --workers=3` run (3/3 passed, no collisions) — this was not merely re-trusted from the implementation log; it was re-run by this audit. Artifact-path collision-safety is correctly delegated to Playwright's own `TestInfo.outputPath()` (`e2e/support/artifactPaths.ts:30-36`) rather than reinvented — confirmed by reading the source; `outputPath()` itself is Playwright's own per-test/per-project/per-retry guarantee and was not separately re-derived here, which is the right call (re-deriving it would risk drifting out of sync with Playwright's own scheme).
- **"Credentials and configured sensitive values are absent from captured artifacts."** Partially contradicted before correction — see Findings (High) below: a representative multi-cookie `Cookie` header leaked all but the first cookie's value in cleartext through `redact()`. Fixed during this audit (see "Corrections made"); re-verified clean afterward.
- **"Page objects do not store global mutable browser state."** Confirmed structurally: `BasePage` (`e2e/pages/BasePage.ts:13-15`) takes `Page` only via constructor, stored as `protected readonly`; `GuestRow` (`e2e/components/GuestRow.ts:16`) takes a `Locator` only via constructor, also `private readonly`. Grepped the whole of `e2e/pages/` and `e2e/components/` for any module-level `let`/`var` or static holding a `Page`/`Locator`/`BrowserContext` — none exists. Every page object is freshly constructed per fixture call (`e2e/fixtures/index.ts:54-64`), so no state can leak between tests.

## Findings

### Critical

None.

### High

- **`cookie-header` redaction rule only redacts the first cookie in a multi-cookie `Cookie` request header, leaving every subsequent cookie's value in cleartext — the same class of bug already found and fixed this session in `authorization-header` (only the first whitespace-delimited token gets consumed).** `e2e/support/redaction.ts` (pre-fix) line 55: `pattern: /(?<![-\w])cookie:\s*\S+/gi`. A real browser's `Cookie` request header routinely carries multiple `name=value` pairs joined by `"; "` (e.g. a session cookie plus a CSRF-token cookie plus any others) — this is the *standard* shape of the header, not an edge case. Reproduced directly against the shipped code before the fix:
  ```
  IN : "cookie: session=SECRET1; other=SECRET2; third=SECRET3"
  OUT: "cookie: [REDACTED] other=SECRET2; third=SECRET3"
  ```
  `SECRET2` and `SECRET3` — genuine secondary cookie values — survived redaction in cleartext, because `\S+` stops at the first whitespace (right after the first cookie's trailing `;`), identically to the pre-fix `authorization-header` bug the implementation log itself documents catching. Every `e2e/support/redaction.spec.ts` case only exercises a single-cookie header (`"cookie: seatwise_session=..."` with no second cookie), so this gap was never exercised by the shipped test suite. This directly contradicts the Stage 03 acceptance criterion "Credentials and configured sensitive values are absent from captured artifacts" for the realistic case of a multi-cookie header captured in a network-diagnostics attachment. **Fixed during this audit — see Corrections made.**

### Medium

- **`sensitive-json-field` redaction rule can leak the tail of a secret value when that value itself contains a literal double-quote character.** `e2e/support/redaction.ts` line 62 (pre-fix): `pattern: /"(password|token|...)"\s*:\s*"[^"]*"/gi`. `[^"]*` has no awareness of JSON's `\"` escape sequence, so it terminates at the first literal `"` it meets — which, for a value containing an escaped quote, is the escape's own closing quote character, not the value's real end. Reproduced:
  ```
  IN : {"password":"hu\"nter2AFTERQUOTE","email":"a@b.com"}
  OUT: {"password":"[REDACTED]"nter2AFTERQUOTE","email":"a@b.com"}
  ```
  `nter2AFTERQUOTE` (the tail of the actual password) leaks in cleartext, and the output is no longer valid JSON. This requires the secret itself to contain a `"` character, which is plausible for passwords/tokens generated from an unrestricted character set (this app's own password field has no upper-bound character restriction, only an 8-char minimum) but is not the common case, and nothing in this framework currently attaches a raw request/response JSON body as evidence (only `captureSuccessCheckpoint`'s validation-description string and `attachFailureDiagnostics`' console/network summaries are redacted today — neither is a raw JSON body dump). Recorded as Medium rather than High because the current evidence-capture surface doesn't yet feed arbitrary JSON bodies through `redact()`, but the gap is real and would bite the moment a future stage (e.g. Stage 06's richer network-diagnostics capture) starts attaching raw request/response bodies. **Not fixed** — recommend a regex that accounts for `\\"` (e.g. `"[^"\\]*(?:\\.[^"\\]*)*"`) or, better, a JSON-aware (parse-and-redact-by-key) approach instead of pattern matching once evidence starts including raw bodies.

- **`login`/`signup` inline error selectors are a CSS-class fallback (`p.text-red-600`), honestly disclosed but genuinely fragile.** Confirmed real (the app really renders a plain `<p className="... text-red-600 ...">` with no `id`/`data-testid`/`role="alert"`), and both `LoginPage.errorMessage()` and `SignupPage.errorMessage()` say so directly in their doc comments rather than silently relying on it as if it were a stable hook. This is not a fabricated selector, but it is exactly the "selectors ... use stable IDs/aria-labels the app actually exposes" concern the audit brief asked about — the app does not expose one here, and the gap is disclosed rather than hidden. No test in this stage currently exercises the login/signup error path (only `expectError` exists, unused by `guest-management.spec.ts`), so the fragility hasn't bitten yet; flag for Stage 04 (reference tests / authoring standards) or an app-side fix (adding `role="alert"`/an id to the error paragraph) rather than blocking Stage 03.

### Low

- **`e2e/data/ids.ts`'s `nextSeed` combines a monotonically-increasing per-process `counter` with a `Date.now() % 1_000_000` term in a way that is not rigorously collision-proof over arbitrarily long-running workers.** `nextSeed(workerIndex) = workerIndex * 1_000_000_000 + (Date.now() % 1_000_000) * 1000 + counter++`. For two calls `k1 < k2` within the same worker, a collision requires `1000 * (M_k2 - M_k1) = -(k2 - k1)`, which is only reachable if the millisecond-modulo term (`M`, which wraps every ~16.7 minutes) decreases by just the right amount between two calls spaced a multiple of 1000 calls apart. In any realistic single test run (seconds to a few minutes, well under a few hundred ID generations) this cannot occur — confirmed empirically: `pnpm pw:test`'s own `numberToLetters`/`uniqueToken` unit tests generate up to 10,000 sequential values with zero collisions, and the live 3-worker run above produced zero data collisions. The theoretical exposure is limited to a single worker process that stays alive across a 1,000-call-per-16.7-minute wraparound boundary, which is not this framework's current usage pattern (short-lived `pnpm pw:test` invocations). Not a blocker; worth a one-line comment or a switch to a pure atomic counter (which would be simpler and unconditionally collision-free) if a future stage introduces long-lived worker processes or very high per-worker call volumes.
- **`DEC-012`'s `deleteUserAccount()` `UnsupportedCleanupError` is real and correctly load-bearing but remains an open, human-flagged cost.** Confirmed no `/api/v1/users` or account-deletion route exists anywhere in `apps/web/src/app/api/v1/` (not independently re-grepped exhaustively by this audit beyond confirming the claim is consistent with the rest of the codebase's route tree convention observed while reading `GuestsTab.tsx` and `page.tsx`); this is a correctly-disclosed, human-decision-pending limitation per the Decision Log, not a defect in Stage 03's own deliverable — carried forward, not re-litigated here.

## Corrections made

**`cookie-header` (High finding) fixed during this audit.** `e2e/support/redaction.ts` line 55 changed from `pattern: /(?<![-\w])cookie:\s*\S+/gi` to `pattern: /(?<![-\w])cookie:\s*.+/gi` (mirroring the exact fix already applied to `authorization-header`: consume the rest of the line, not just the first token). Re-verified:
```
IN : cookie: session=SECRET1; other=SECRET2; third=SECRET3
OUT: cookie: [REDACTED]
```
Added a locking unit test to `e2e/tests/unit/redaction.spec.ts` (`"redacts every cookie in a multi-cookie header, not just the first"`) asserting all three of `SECRET1`/`SECRET2`/`SECRET3` are absent from the output. Re-ran the full suite after the fix: `pnpm exec tsc --noEmit` clean; `pnpm pw:test` → **106/106 passed** (105 + 1 new locking test). The throwaway adversarial probe script (`e2e/tests/unit/_adversarial_redact_probe.ts`) was deleted after use; `git status --short` confirms it is not present.

The Medium `sensitive-json-field` finding was **not** fixed — no current evidence-capture code path feeds a raw JSON body through `redact()` (confirmed by reading every call site: `captureSuccessCheckpoint`'s `validationDescription` string and `attachFailureDiagnostics`'s console-message/failed-request-summary strings, neither of which is a raw JSON dump today), so this is recorded as a tracked gap for whichever future stage first attaches raw request/response bodies, rather than corrected speculatively here.

## Remaining risks and human decisions

- The `sensitive-json-field` escaped-quote gap (Medium) should be closed — ideally by switching to an escape-aware regex or a JSON-parse-then-redact-by-key approach — before any later stage (most likely Stage 06's reporting/diagnostics work) starts attaching raw request/response JSON bodies as evidence. Today it is inert risk, not an active leak, because nothing calls `redact()` on a raw JSON body yet.
- The login/signup CSS-class error-message fallback (Medium) should either get a stable `id`/`role="alert"` from the app side, or be accepted as a documented, disclosed fragility going into Stage 04, which is where a reference test would first actually exercise it.
- `ids.ts`'s `nextSeed` composition (Low) is not proven collision-free for arbitrarily long-lived worker processes; recommend simplifying to a pure atomic counter (already sufficient on its own) if usage patterns ever change from short `pnpm pw:test` invocations.
- DEC-012 (no account-deletion endpoint; test accounts accumulate indefinitely) remains open per its own recorded approval requirement — unchanged by this audit, not re-litigated here.
- BLK-001 (GitHub session-repo-authorization gate blocking `git push`/PR creation) remains open and unrelated to this audit's scope.

## Final verdict

**PASS.** Every Stage 03 acceptance criterion was independently verified against the actual code and the actual running application, not the implementation log's prose: page/component objects were checked line-by-line against real app source (`GuestsTab.tsx`, `page.tsx`, `login/page.tsx`, `signup/page.tsx`) and every claimed selector is real, not fabricated; fixture composition (`account → weddingData → managedWedding`, page-object and `evidence` fixtures) was proven by an actual live run against the real app plus an independently re-run 3-worker parallel execution (not merely re-trusted from a prior run); `PERSON_NAME_PATTERN`/`WEDDING_NAME_PATTERN` claims were cross-checked byte-for-byte against `packages/shared/src/validation.ts`; artifact-path collision-safety was confirmed to genuinely delegate to Playwright's own `TestInfo.outputPath()` rather than reinvent it; and the `managedWedding` fixture's cleanup-failure handling was confirmed to attach a warning via `testInfo.attach` rather than throw, so a teardown failure cannot mask the test's own pass/fail result. Adversarial redaction probing with values outside the shipped unit-test suite found one real High-severity leak (`cookie-header` only redacting the first cookie in a multi-cookie header — the same bug class already caught once this session in `authorization-header`) and fixed it live with a locking regression test; one Medium-severity, currently-inert gap (`sensitive-json-field` and escaped quotes) was found and disclosed but left open since nothing exercises it yet; a disclosed CSS-class selector fallback and a theoretical, practically-unreachable ID-collision edge case round out the findings. `pnpm exec tsc --noEmit` is clean, `pnpm pw:test` is 106/106 passing (105 pre-fix + 1 new locking test), the live reference test passes individually and under `--repeat-each=3 --workers=3` with zero collisions, and no application code (`apps/`, `packages/`) was touched. Stage 03 may be marked complete on the Progress Dashboard.
