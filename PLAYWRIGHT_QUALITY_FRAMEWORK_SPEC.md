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

**Current stage:** 02 (implementation complete, pending independent audit)  
**Current task:** Independent review of Stage 02 before it may be marked PASS  
**Last verified task:** Stage 01 Playwright foundation and production guard, verified by an independent review pass  
**Last passing audit:** `quality/audits/stage-01-audit.md` — PASS  
**Active blockers:** None recorded  
**Next action:** Dispatch independent review of Stage 02, write `quality/audits/stage-02-audit.md`, then begin Stage 03

### Progress dashboard

- [x] Stage 00 — Repository discovery and implementation plan
- [x] Stage 01 — Playwright foundation and environment safety
- [ ] Stage 02 — Test governance, metadata, tags, and value model
- [ ] Stage 03 — Page objects, fixtures, test data, and evidence architecture
- [ ] Stage 04 — Test-authoring standards, enforcement, and reference tests
- [ ] Stage 05 — Tag-expression runner and safe execution workflow
- [ ] Stage 06 — Test-run reporting and diagnostic artifacts
- [ ] Stage 07 — Suite review, coverage analysis, and test catalog
- [ ] Stage 08 — Claude Code skills, commands, subagents, and hooks
- [ ] Stage 09 — Failure triage and controlled test repair
- [ ] Stage 10 — CI, documentation, adoption, and operational hardening
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

### Blocker log

| ID | Date | Stage | Blocker | Required decision or action | Status |
|---|---|---|---|---|---|
| — | — | — | None | — | — |

### Implementation log

Append one row before ending each implementation session.

| Date/time | Stage | Work completed | Verification evidence | Files changed | Next action |
|---|---|---|---|---|---|
| 2026-09-10 | 00 | Repository discovery completed; Project Profile filled in with no unexplained TBDs; five decisions recorded (DEC-002..005); no framework dependency installed | Discovery claims cross-checked live against the repo (package manager/version, Node version, absence of Playwright/CI/`.claude` assets, ESLint/TypeScript config paths, existing `apps/mobile/__tests__`, absence of any deployment config) by an independent adversarial review pass before the audit was marked PASS | `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Sections 4 and 5), `quality/audits/stage-00-audit.md` (new) | Begin Stage 01 — Playwright foundation and environment safety |
| 2026-09-10 | 01 | Installed `@playwright/test`, `typescript`, `zod`, `@types/node` as root devDependencies; created the full target directory skeleton (`e2e/`, `playwright-framework/`, `artifacts/playwright/`, all `.gitkeep`-tracked); implemented a zod-validated typed environment config, a fail-closed production/mutation guard wired into Playwright's `globalSetup` (blocks before any browser launches), `playwright.config.ts` (chromium as the run-by-default project; firefox/webkit defined but unused per DEC-003; native HTML+list reporter; trace/screenshot-on-failure), a framework health test, and root `tsconfig.json`. Added `pw:*` package scripts and gitignore rules for generated report/test-result output. Documented install/run commands in README. Two decisions recorded (DEC-006, DEC-007) | `pnpm exec tsc --noEmit` clean; `pnpm pw:list` shows exactly the 18 intended tests across 3 files with zero bleed from `apps/mobile/__tests__`; `pnpm pw:test` — 18/18 passed, including one real Chromium `page` launch; the production guard was proven end-to-end through Playwright itself in three live scenarios (mutating+production → blocked before any project ran, exit 1; read-only+production+no approval → blocked; read-only+production+approval → 18/18 passed); `git status` after `git add -A` shows only intended source/config/`.gitkeep` files staged, no generated report/test-result content | `package.json`, `pnpm-lock.yaml`, `.gitignore`, `README.md`, `tsconfig.json` (new), `playwright.config.ts` (new), `e2e/support/{env,productionGuard,globalSetup}.ts` (new), `e2e/tests/framework-health.spec.ts` (new), `playwright-framework/tests/{env,productionGuard}.spec.ts` (new), directory skeleton `.gitkeep`s (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Sections 4), `quality/audits/stage-01-audit.md` (new) | Begin Stage 02 — Test governance, metadata, tags, and value model |
| 2026-09-10 | 02 | Installed `yaml`, `tsx` as root devDependencies. Built versioned zod schemas for requirements/tag-taxonomy/value-model/overrides/test-inventory/run-result/maintenance-result (DEC-008); wrote `quality/requirements.yaml` (18 real entries seeded from README, 2 explicit fake placeholders — DEC-009), `quality/tag-taxonomy.yaml` (7 dimensions per Section 9.1, plus conflicts/aliases), `quality/test-value-model.yaml` (6 value + 8 quality criteria matching Section 8.3/8.5 exactly, weights validated to total 100 by the schema itself — DEC-010), generated `quality/test-value-model.md`, and an empty `quality/value-overrides.yaml`. Implemented deterministic value/quality scoring arithmetic (`playwright-framework/scoring/`) that treats a missing or human-review-flagged criterion as provisional rather than a fabricated zero, a value-band lookup, and a human-override layer that never mutates the calculated result. Implemented tag-taxonomy validation (unknown tags, exactly-one/at-least-one dimension rules, conflicts, aliases) and a cross-cutting metadata validator (unique test IDs, unmapped/unknown requirement references, empty objective/expectedOutcome). Implemented `defineQualityTest`, a thin wrapper around Playwright's native `test(title, {tag, annotation}, body)` that validates metadata at collection time (DEC-011). Added two CLI scripts wired into `package.json` (`pw:validate-metadata`, `pw:generate-value-model-md`) and folded the former into `pw:validate`. Added 53 new unit tests (schemas, tag validation, cross-cutting metadata validation, scoring boundaries/bands/missing-info/model-version-change/overrides, real-file loader round-trips including a malformed-YAML and a bad-weights failure case, markdown drift detection, and `defineQualityTest` against the live taxonomy) | `pnpm exec tsc --noEmit` clean; `pnpm pw:validate-metadata` reports 20 requirements / 7 dimensions (33 tags) / model 1.0.0 (6+8 criteria) / 0 overrides, all valid; `pnpm pw:test` — 71/71 passed (18 carried over from Stage 01 + 53 new), including a live manual check that intentionally desyncing `test-value-model.yaml` from the committed `.md` makes the drift-detection test fail, then passes again once reverted; `git status` shows only new framework/quality files plus `package.json`/`pnpm-lock.yaml` — no application code (`apps/`, `packages/`) touched | `package.json`, `pnpm-lock.yaml`, `quality/{requirements,tag-taxonomy,test-value-model}.yaml` (new), `quality/test-value-model.md` (new, generated), `quality/value-overrides.yaml` (new), `playwright-framework/metadata/{schemas,loaders,tagValidation,validateMetadata,defineQualityTest}.ts` (new), `playwright-framework/scoring/{types,bands,computeScore,valueScore,qualityScore,applyOverride}.ts` (new), `playwright-framework/cli/{validate-metadata,generate-value-model-md,renderValueModelMarkdown}.ts` (new), `playwright-framework/tests/{schemas,tagValidation,validateMetadata,scoring,loaders,valueModelMarkdown,defineQualityTest}.spec.ts` (new), `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` (Section 4) | Independent review of Stage 02, then begin Stage 03 — Page objects, fixtures, test data, and evidence architecture |

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

- [ ] Review every criterion for ambiguity, double counting, and separation of value from quality.
- [ ] Verify unknown information produces human review rather than fabricated evidence.
- [ ] Test all schema failures and override rules.
- [ ] Resolve findings and rerun unit tests.
- [ ] Write a passing `quality/audits/stage-02-audit.md` and update the Progress Dashboard.

## Stage 03 — Page objects, fixtures, test data, and evidence architecture

### Tasks

- [ ] Implement the base page-object pattern and at least one reusable component-object example.
- [ ] Centralize application selectors; use stable IDs where provided.
- [ ] Implement typed fixtures for page objects and shared components.
- [ ] Implement authentication-state fixtures without embedding credentials.
- [ ] Implement unique test-data naming and worker-safe identity helpers.
- [ ] Implement project-specific data setup/cleanup interfaces with explicit no-op or unsupported states.
- [ ] Implement a named success-evidence helper that attaches screenshot and validation description.
- [ ] Implement failure diagnostics for screenshots, console errors, failed requests, and traces.
- [ ] Implement configurable redaction/sanitization before report rendering.
- [ ] Ensure artifact paths are unique across projects, workers, retries, and test IDs.

### Acceptance criteria

- A test can request page objects, data helpers, and evidence through typed fixtures.
- Parallel executions do not collide on data or artifact filenames.
- Credentials and configured sensitive values are absent from captured artifacts.
- Page objects do not store global mutable browser state.

### Stage 03 audit gate

- [ ] Review page/component boundaries and selector centralization.
- [ ] Exercise fixtures under parallel and retry conditions.
- [ ] Attempt redaction with representative sensitive values.
- [ ] Verify cleanup errors are reported without hiding the original test failure.
- [ ] Resolve findings, write a passing `quality/audits/stage-03-audit.md`, and update the Progress Dashboard.

## Stage 04 — Test-authoring standards, enforcement, and reference tests

### Tasks

- [ ] Write `PLAYWRIGHT_TESTING.md` with authoring, debugging, metadata, tagging, evidence, and review guidance.
- [ ] Define naming and directory conventions.
- [ ] Define Arrange/Act/Assert and named `test.step` expectations.
- [ ] Require observable assertions and prohibit screenshot-only validation.
- [ ] Add lint/static rules for raw selectors outside approved abstractions.
- [ ] Add checks for fixed waits, `test.only`, unreasoned skip/fixme/fail, swallowed errors, and missing assertions.
- [ ] Add checks for unknown tags, duplicate IDs, missing mappings, and stale metadata.
- [ ] Add a documented exception mechanism requiring rationale and review.
- [ ] Create a high-quality read-only reference test against a safe project behavior.
- [ ] Create a high-quality mutating reference test with isolated setup and cleanup when the project permits it.
- [ ] Create examples of intentionally bad patterns used only by framework validation tests.
- [ ] Add repeated and parallel runs that test independence of the reference tests.

### Acceptance criteria

- A manual tester can follow the guide to understand and modify a reference test.
- Bad-pattern fixtures are detected by automated validation.
- Reference tests pass individually, in reverse selection order, in parallel, and through configured repeat execution.
- Test source reads primarily as business intent rather than selector mechanics.

### Stage 04 audit gate

- [ ] Review reference tests against every rule in Sections 7 and 8.
- [ ] Verify enforcement catches each prohibited example without false positives on reference tests.
- [ ] Have the reviewer explain each reference test's objective without reading its page-object implementation first.
- [ ] Resolve findings, write a passing `quality/audits/stage-04-audit.md`, and update the Progress Dashboard.

## Stage 05 — Tag-expression runner and safe execution workflow

### Tasks

- [ ] Implement a cross-platform TypeScript CLI for tag selection.
- [ ] Implement AND, OR, NOT, parentheses, and saved named selections.
- [ ] Validate all tags against the taxonomy before invoking Playwright.
- [ ] Add a list-only preview mode that shows selected test IDs, titles, tags, and data impact.
- [ ] Detect contradictory expressions and empty selections with actionable messages.
- [ ] Translate validated expressions into Playwright-native filtering without unsafe shell interpolation.
- [ ] Invoke the Playwright CLI as the authoritative execution engine and forward only explicitly supported, validated options.
- [ ] Implement environment and production preflight checks.
- [ ] Add explicit confirmation requirements for allowed production read-only execution.
- [ ] Capture the normalized expression and exact execution configuration in the run manifest.
- [ ] Add package commands for common selections such as read-only, smoke, regression, and critical.
- [ ] Add parser and selection unit tests, including quoting and injection attempts.

### Acceptance criteria

- AND, OR, NOT, parentheses, and saved selections return expected test inventories.
- Preview and actual execution select the same tests.
- Unknown tags and shell-like malicious input are rejected safely.
- Mutating production tests cannot start.
- A zero-test selection is visible and is not represented as a successful test run.

### Stage 05 audit gate

- [ ] Compare runner selection with direct Playwright discovery across a representative query matrix.
- [ ] Test production guards and adversarial tag input.
- [ ] Verify friendly error messages for a non-developer user.
- [ ] Resolve findings, write a passing `quality/audits/stage-05-audit.md`, and update the Progress Dashboard.

## Stage 06 — Test-run reporting and diagnostic artifacts

### Tasks

- [ ] Configure Playwright's native HTML reporter as a diagnostic companion.
- [ ] Implement a custom reporter that writes normalized run-result JSON.
- [ ] Create the self-contained run-report HTML template.
- [ ] Render run metadata, selection, status counts, attempts, steps, assertions, and source links.
- [ ] Render plain-language pass and failure explanations from structured evidence.
- [ ] Attach success-checkpoint and failure screenshots.
- [ ] Link traces, console/network diagnostics, native report, and optional video.
- [ ] Distinguish initial pass, retry-pass/flaky, consistent failure, timeout, skip, expected failure, quarantine, and infrastructure failure.
- [ ] Implement sanitized stack traces and artifact path handling.
- [ ] Implement a local report-serving command and optional editor deep links.
- [ ] Validate JSON against its schema before rendering HTML.
- [ ] Add snapshot or DOM-level tests for all major report states.

### Acceptance criteria

- Representative pass, assertion failure, timeout, retry-pass, skip, and setup failure render correctly.
- Every failed test has actionable evidence or a visible explanation of missing evidence.
- Every claimed successful validation is backed by an executed assertion.
- The report works offline and contains no absolute path unless configured for local editor linking.
- Report generation errors cause a nonzero result without erasing raw Playwright output.

### Stage 06 audit gate

- [ ] Review the report as a manual tester, developer, and release decision-maker.
- [ ] Validate accessibility, filtering, links, artifact retention, and sensitive-data handling.
- [ ] Compare displayed counts with machine JSON and Playwright's native result.
- [ ] Resolve findings, write a passing `quality/audits/stage-06-audit.md`, and update the Progress Dashboard.

## Stage 07 — Suite review, coverage analysis, and test catalog

### Tasks

- [ ] Implement complete test discovery using Playwright and TypeScript-aware static analysis where needed.
- [ ] Implement requirement-to-test and risk-to-test mapping.
- [ ] Calculate requirement, risk-weighted, tag, data-impact, browser, role, and freshness coverage.
- [ ] Detect uncovered requirements and requirements covered only by unhealthy tests.
- [ ] Detect likely duplicates and label them as recommendations, not automatic deletions.
- [ ] Evaluate every test against the versioned value and quality rubrics.
- [ ] Mark uncertain judgments for human review with confidence and missing information.
- [ ] Implement previous-report comparison and score/model change tracking.
- [ ] Create the self-contained suite-review HTML template.
- [ ] Include the full current high-value criteria list in the report.
- [ ] Itemize every discovered test with all fields required by Section 10.3.
- [ ] Implement repository-relative links, line numbers, copyable paths, and optional editor links.
- [ ] Add filters for value, quality, feature, risk, result, freshness, quarantine, and review status.
- [ ] Generate a prioritized human-review queue.
- [ ] Add automated report fixture tests for complete, missing, invalid, duplicate, and provisional metadata.

### Acceptance criteria

- Playwright's discovered test count exactly matches the report catalog after documented project expansion rules.
- No invalid test disappears silently.
- Coverage percentages state their denominator and exclusions.
- Every score shows its breakdown, evidence, confidence, and model version.
- A criteria-model change predictably reevaluates all tests.
- Human overrides are preserved and clearly identified.

### Stage 07 audit gate

- [ ] Manually trace a sample of high-, medium-, and low-value scores back to source evidence.
- [ ] Challenge duplicate, coverage, and risk-weighted calculations with controlled fixtures.
- [ ] Verify every test has a working source reference and appears exactly once per intended Playwright project representation.
- [ ] Verify the report never presents unsupported AI judgment as fact.
- [ ] Resolve findings, write a passing `quality/audits/stage-07-audit.md`, and update the Progress Dashboard.

## Stage 08 — Claude Code skills, commands, subagents, and hooks

### Tasks

- [ ] Implement every skill in Section 11.2 as a project skill with focused instructions.
- [ ] Ensure slash invocations accept documented arguments and show concise help.
- [ ] Ensure each skill delegates deterministic work to the framework CLIs.
- [ ] Implement read-only reviewer and triage subagents with minimal necessary tools.
- [ ] Implement the scoped repair write guard.
- [ ] Implement the lightweight post-edit validator.
- [ ] Implement the scoped bootstrap stage-gate/stop check.
- [ ] Use current documented Claude Code hook JSON and exit behavior.
- [ ] Add automated tests for allowed, denied, malformed, and missing hook inputs.
- [ ] Test all skills from a fresh Claude Code session or closest available noninteractive harness.
- [ ] Document how skills, hooks, and optional compatibility commands are installed and invoked.
- [ ] Document behavior when Claude Code features or versions are unavailable.

### Acceptance criteria

- Each skill can be invoked independently and produces its documented artifact or stop condition.
- Reviewer and triage agents cannot edit files.
- Repair cannot write application source or unrelated files without an explicit human-approved scope change.
- Hooks do not recursively invoke Claude, leak secrets, or launch expensive full-suite runs on ordinary edits.
- Stage completion is blocked when the audit artifact is missing or failing.

### Stage 08 audit gate

- [ ] Review skill scopes, allowed tools, arguments, failure paths, and stopping rules.
- [ ] Attempt unauthorized writes through the repair workflow and verify they are blocked.
- [ ] Test hook behavior from main and subagent contexts where applicable.
- [ ] Verify current Claude Code documentation rather than relying on stale syntax.
- [ ] Resolve findings, write a passing `quality/audits/stage-08-audit.md`, and update the Progress Dashboard.

## Stage 09 — Failure triage and controlled test repair

### Tasks

- [ ] Implement maintenance-report JSON schema and HTML template.
- [ ] Implement artifact collection by run ID without rerunning first.
- [ ] Implement classification categories from Section 10.4.
- [ ] Require evidence-for, evidence-against, confidence, and missing-information fields.
- [ ] Compare failure evidence with requirements, test intent, metadata, and relevant code history when available.
- [ ] Prohibit repair for probable application defects and insufficient-evidence outcomes.
- [ ] Require explicit test ID and maintenance recommendation for `/pw-repair-test`.
- [ ] Require intended behavior or human approval before changing an expected result.
- [ ] When functionality expands, determine whether to add focused validation to the existing test or create a separate independent test; do not overload one test with unrelated outcomes.
- [ ] Constrain repair to the smallest justified change.
- [ ] Prohibit automatic visual-baseline updates.
- [ ] Show the proposed or completed diff and explain preservation of the original objective.
- [ ] Rerun the repaired test repeatedly and then run related tests.
- [ ] Regenerate the suite-review report after any test, page object, fixture, metadata, or scoring change.
- [ ] Preserve original failure artifacts and link the before/after results.

### Acceptance criteria

- Controlled fixtures produce the correct classification for application, test, data, infrastructure, flaky, and unknown failures.
- A probable application bug remains visible and is not “fixed” by changing the test.
- Repair cannot broaden selectors, remove assertions, add sleeps, or skip a test without explicit justified review.
- A repaired test passes repeated and related execution while preserving its objective.
- Maintenance and review reports show a complete audit trail.

### Stage 09 audit gate

- [ ] Run adversarial scenarios designed to tempt the repair workflow to hide a defect.
- [ ] Review classification confidence and ambiguous-evidence handling.
- [ ] Verify repair write scope and human-approval requirements.
- [ ] Verify suite review automatically follows test modification.
- [ ] Resolve findings, write a passing `quality/audits/stage-09-audit.md`, and update the Progress Dashboard.

## Stage 10 — CI, documentation, adoption, and operational hardening

### Tasks

- [ ] Integrate metadata validation, lint, typecheck, and framework unit tests into CI.
- [ ] Add an appropriate browser-test CI workflow using project conventions.
- [ ] Configure retries, workers, sharding, and timeouts appropriate to CI resources.
- [ ] Upload run, trace, screenshot, and report artifacts with documented retention.
- [ ] Ensure CI secrets are scoped and never printed.
- [ ] Add branch/PR status behavior for failed, flaky, quarantined, and zero-test runs.
- [ ] Add scheduled regression and optional stale/flaky review jobs.
- [ ] Complete `PLAYWRIGHT_TESTING.md` for a manual tester.
- [ ] Add a first-test tutorial, tagging cheat sheet, common commands, debugging guide, and report-review guide.
- [ ] Add good/bad examples and a manual-test-to-automation worksheet.
- [ ] Document adding requirements, features, tags, page objects, fixtures, and test data.
- [ ] Document updating the value model and approving overrides.
- [ ] Document report retention, cleanup, and disk-usage expectations.
- [ ] Document framework upgrade and compatibility checks.

### Acceptance criteria

- A clean checkout can install, validate, list, and run the documented baseline workflow.
- CI publishes usable reports even when tests fail.
- A manual tester can author and run a reference-style test using only the documentation.
- Flaky or zero-test runs cannot appear as an ordinary clean pass.
- No secrets or sensitive artifacts are exposed in CI output.

### Stage 10 audit gate

- [ ] Exercise the clean-checkout setup and documented commands.
- [ ] Review CI behavior for pass, failure, retry-pass, cancellation, and report-generation failure.
- [ ] Conduct a documentation walkthrough from the perspective of a new manual tester.
- [ ] Resolve findings, write a passing `quality/audits/stage-10-audit.md`, and update the Progress Dashboard.

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
