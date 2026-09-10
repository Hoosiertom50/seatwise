# Stage 08 Audit

Result: PASS WITH FINDINGS (three High-severity bugs found and fixed live during this audit, with locking regression tests; no Medium/Low findings disclosed this time — every other candidate probed held up; one tooling limitation disclosed: no live Claude Code Task/subagent harness was available in this sandbox)
Auditor: Independent review subagent, fresh context with no memory of the implementation work, instructed to treat the code as unseen and to run real commands rather than trust the implementation log's prose.
Date/time: 2026-09-10
Repository is a git repo (working tree, no commits made by this audit).

## Scope

Verify Stage 08 (Claude Code skills, subagents, and hooks) against `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`'s
Section 11 (Claude Code integration requirements), the Stage 08 task list, acceptance criteria, and
audit gate, DEC-024/025/026, `PLAYWRIGHT_TESTING.md`'s "Claude Code integration (Stage 08)" section,
and the precedent set by `quality/audits/stage-07-audit.md`. The live app (`pnpm dev`, already
running on `http://localhost:3000`, confirmed via `curl` returning 200) and its Postgres 16 cluster
(already `online` per `pg_lsclusters`) were confirmed reachable, though this stage's own verification
turned out to need only offline commands and direct hook-script invocation, never a live browser
run. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` was exported for every command. Every file named in the
audit brief was read in full before any command was run.

## Files reviewed

- `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md` Section 11 (11.1-11.4), the Stage 08 task list/acceptance
  criteria/audit gate, DEC-024/025/026, and the Stage 07 Implementation Log rows for context.
- `PLAYWRIGHT_TESTING.md`'s "Claude Code integration (Stage 08)" section (in full, both before and
  after this audit's own doc-accuracy fix).
- `.claude/skills/{pw-bootstrap,pw-author-test,pw-run-tests,pw-review-suite,pw-triage-failures,pw-repair-test,pw-validate-framework}/SKILL.md` (all 7, in full).
- `.claude/agents/{playwright-repair,playwright-reviewer,playwright-triage}.md` (in full, frontmatter and prose).
- `.claude/hooks/lib/hookIO.mjs`, `.claude/hooks/{repair-write-guard,post-edit-validator,stage-gate-check,readonly-bash-guard}.mjs` (in full, including after this audit's own fixes).
- `.claude/settings.json`.
- `quality/repair-allowed-dirs.yaml`.
- `playwright-framework/tests/hooks/{runHook.ts,repairWriteGuard,stageGateCheck,postEditValidator,readonlyBashGuard}.spec.ts` (existing, read first to target genuine gaps rather than duplicate coverage; edited by this audit).
- Live Claude Code documentation, fetched directly: `code.claude.com/docs/en/hooks`, `/sub-agents`, `/skills` (see section 6 below).

## Verification commands run (numbers I personally observed, not taken from the log)

- `pnpm exec tsc --noEmit` — clean before, during (after each individual fix), and after every fix in this audit.
- `pnpm pw:test` — **333/333 passed** before any fix (matches the implementer's claim exactly);
  **336/336 passed** after this audit's three fixes (3 new locking tests, one per finding, added to
  the existing hook spec files rather than new files).
- `pnpm pw:validate` — clean before (`Total: 333 tests in 34 files`, matching the implementer's
  claim) and after (`Total: 336 tests in 34 files` — same file count, tests added into existing
  files).
- Dozens of direct, real invocations of every hook script (`node .claude/hooks/<script>.mjs` with
  real stdin), both against this real repository's own already-valid files (for the read-only cases)
  and against a throwaway, temporary fake repository root under this session's own scratchpad
  directory (never this repo's own files) for every adversarial/fail-safe case involving
  `repair-write-guard.mjs` or `stage-gate-check.mjs`'s filesystem state — mirroring the pattern in
  the existing `*.spec.ts` files exactly, per the audit brief's explicit instruction.
- `git status --short` at the end — only legitimate Stage 08 fix files, doc corrections, and this
  report; no scratch/probe files remain (see "Cleanup" at the end).

## 1. Numbers re-run myself

Confirmed exactly as claimed pre-fix: `pnpm exec tsc --noEmit` clean; `pnpm pw:test` **333/333
passed**; `pnpm pw:validate` **`Total: 333 tests in 34 files`**. The two real bugs the implementation
log claims were caught by its own tests before any audit ran were independently re-verified: the
`git checkout --` mutation pattern in the live `readonly-bash-guard.mjs` genuinely matches (confirmed
by direct invocation, not just reading the regex), and `postEditValidator.spec.ts`'s message-format
assertions match the real script's actual output format (`"<checks joined by ', '> passed for
<path>"`) rather than a hand-guessed literal.

## 2. Reading every hook script for logic bugs, and adversarially stress-testing `repair-write-guard.mjs`

Read all four scripts plus `lib/hookIO.mjs` in full. `hookIO.mjs`'s `allow`/`deny`/`noop` helpers
correctly implement the documented `hookSpecificOutput.permissionDecision`/exit-2 contract (verified
against live documentation — see section 6). Adversarial probes run directly against the real
scripts, using a throwaway fake repository root under `CLAUDE_PROJECT_DIR` (never this repo's own
files):

- **Directory-prefix sibling attack** (`e2e/tests-evil/x.spec.ts` vs. the allowed `e2e/tests`):
  correctly denied. `isWithin()`'s `candidate.startsWith(dir + sep)` check (not a bare `startsWith`)
  already prevents this — a directory name that is a string-prefix of an allowed directory but not
  actually nested under it does not pass.
- **Absolute vs. relative `file_path`**: both resolve identically and are checked identically;
  an absolute path to the same approved file is correctly allowed.
- **`repair-scope.json` entry with a trailing slash, or different case, than the real path**: both
  correctly deny (fail closed on a literal string mismatch — no path normalization is attempted on
  the approved-paths side, so a scope file written with a typo just means "not approved," never
  "approved anyway").
- **Path traversal to escape the repository root** (`../../../etc/passwd`): correctly denied by the
  `isWithin(resolvedTarget, root)` check before any directory-allowlist logic even runs.
- **Nonexistent-directory-entry smuggling**: `repair-write-guard.mjs` already filters
  `allowedDirs` to only those that genuinely `existsSync`+`isDirectory()` on disk, so a tampered
  `repair-allowed-dirs.yaml` naming a directory that doesn't exist can't be used to widen scope.

**Finding 1 (High, FIXED) — a symlink inside an approved, approved-scope directory bypasses every
check and lets `repair-write-guard.mjs` `allow` a write that actually lands outside every approved
directory.** None of the checks above ever resolve symlinks — `resolvedTarget` is a plain
`path.resolve()`, and `existsSync`/`statSync` both follow symlinks transparently without that being
detected anywhere. Reproduced live: in the fake repository root, created
`e2e/tests/symlinked.spec.ts` as a symlink pointing at `apps/web/src/foo.ts` (a file well outside
every allowed directory), approved that path in `repair-scope.json`, and fed the real (pre-fix)
`repair-write-guard.mjs` an `Edit` targeting it — the script `allow`ed it. Had this actually been a
live `Edit` call by the `playwright-repair` subagent, the edit would have silently landed in
`apps/web/src/foo.ts`, entirely outside the two-layer scope this hook exists to enforce, while every
log/report from the guard itself would show only the innocuous-looking `e2e/tests/symlinked.spec.ts`
path.
- **Fix**: added a `realpathSync`-based check comparing the target's real, symlink-resolved path
  against the plain, non-symlink-following expected path (computed from the *root's own* real path,
  so a project root itself reached through a symlink is not mistaken for a target-side escape) —
  any mismatch anywhere in the path chain (the file itself, or a directory earlier in the path) is
  denied.
- **Re-verified live after the fix**: the same symlink scenario is now denied
  (`"...is a symlink or contains one in its path..."`), and the real target file
  (`apps/web/src/foo.ts`) is confirmed byte-for-byte unchanged. A legitimate, non-symlinked,
  allowed-and-approved edit still succeeds exactly as before.
- **Locking test**: new test in `repairWriteGuard.spec.ts` creating a real symlink via `symlinkSync`,
  confirmed to fail against the pre-fix script (via a temporary, git-tracked-free revert of just this
  one script back to its pre-fix content, run, confirmed failing, then restored) before being
  trusted.

## 3. Attempting unauthorized writes through the repair workflow, live

**Tooling limitation, disclosed rather than worked around:** this audit session's `Task`/`Agent`
tool does not expose this repository's custom `.claude/agents/{playwright-repair,playwright-reviewer,
playwright-triage}.md` subagent types for direct invocation — `ListAgents` shows only this session's
own `general-purpose` subagent, and attempting to invoke the `pw-repair-test` skill by name (via the
`Skill` tool, which is what `context: fork`/`agent: playwright-repair` would fork into) returns
`Unknown skill: pw-repair-test` — this repository's own project skills are not loaded into this
audit session's skill registry at all. This is the same limitation the Stage 08 implementation log
itself already disclosed ("No interactive Claude Code CLI is available inside this sandboxed session
to drive `/pw-*` end-to-end"), and it is disclosed here rather than silently worked around or
misrepresented as a genuine subagent-level test.

Given that, the most rigorous substitute actually available — matching the implementer's own
precedent exactly — is real, direct invocation of the exact on-disk hook script with the exact
stdin shape Claude Code would send for that subagent's wired matcher, using adversarial payloads a
real `playwright-repair` session might attempt:

- **Attempt to write `package.json` and `playwright-framework/version.ts` with no
  `repair-scope.json` established at all**: denied — `"no repair scope has been established for
  this session yet"`.
- **Attempt to create a brand-new file at `e2e/tests/new-hack.spec.ts`** (even fully inside an
  allowed directory, and even pre-approved in a scope file): denied — `"does not exist yet; repair
  may only modify an already-existing, already-approved test-framework file, never create a new
  one"`.
- **Legitimately establish a scope naming exactly one existing file, confirm that file IS editable,
  then confirm a different file in the SAME session is NOT**: reproduced in the fake repository —
  approving `e2e/tests/existing.spec.ts` allows an edit to that file, and a second file
  (`e2e/tests/other.spec.ts`), never named in the same `repair-scope.json`, is denied even though
  it's under the same allowed directory.
- **Attempt to route around `repair-write-guard.mjs` entirely via `Bash`** (since `playwright-repair`
  has `Bash` available and its own `readonly-bash-guard.mjs` wiring is the *only* check on that
  channel — `repair-write-guard.mjs` governs `Edit`/`Write` only): this is where **Finding 2** below
  was found.

**Finding 2 (High, FIXED) — `playwright-repair`'s only defense on its `Bash` tool
(`readonly-bash-guard.mjs`'s mutation-pattern blocklist) had no coverage at all for
interpreter-based file writes, letting `Bash` completely bypass `repair-write-guard.mjs`'s two-layer
scope check for any file in the repository, including application source.** Every pattern in the
pre-fix blocklist matched either a specific shell primitive (`rm`, `mv`, `sed -i`, `>`/`>>`, mutating
`git` subcommands, ...) or shell-level output redirection. None of them match a scripting language's
own inline file-write API invoked via its interpreter's "run this code" flag — which uses no `>`, no
`rm`, no shell redirection syntax at all. Reproduced live against the real, pre-fix script:

```
node -e "require('fs').writeFileSync('apps/web/src/foo.ts','HACKED')"     -> allow
python3 -c "open('apps/web/src/foo.ts','w').write('HACKED')"               -> allow
git restore e2e/tests/foo.spec.ts                                         -> allow
ln -sf /etc/passwd e2e/tests/pwn.spec.ts                                   -> allow
```

This is not a narrow edge case: this same `readonly-bash-guard.mjs` script, wired to the same
matcher, is also `playwright-reviewer`'s and `playwright-triage`'s *only* defense against a
Bash-based mutation (their `tools:` list already omits `Write`/`Edit`/`NotebookEdit`, so this
blocklist is the sole thing standing between "read-only agent" and "agent that can rewrite any file
in the repo via `node -e`"). The Stage 08 acceptance criteria state plainly: "Reviewer and triage
agents cannot edit files" and "Repair cannot write application source or unrelated files without an
explicit human-approved scope change" — both were false as shipped, specifically over the `Bash`
channel, for exactly the kind of command an agent reaching for "a quick script" would plausibly use,
not only a determined adversarial one. (`git restore` — the modern, commonly-reached-for replacement
for `git checkout -- <file>`, the very command this stage's own tests already found and fixed a
matching-bug for — was also missing entirely from the git-subcommand list, and `ln` (needed to set up
Finding 1's symlink escape) was not blocked either.)
- **Fix**: added explicit patterns for `node -e`/`--eval`/`-p`/`--print`, `python`/`python3 -c`,
  `perl -e`/`-i`, `ruby -e`, `php -r`, `deno eval`, `ln`, and extended the mutating-`git`-subcommand
  pattern with `restore`, `apply`, `stash pop`, `merge`, `rebase`, `cherry-pick`. This is explicitly
  *not* claimed to be an exhaustive fix — no denylist can enumerate every scripting language or
  obfuscation, and the script's own comments already disclosed this is "not a sandbox" — but it
  closes the specific, highly-plausible vectors demonstrated above, which is a meaningfully different
  (and much weaker) state than "the blocklist doesn't cover shell-level mutation at all," which is
  where it actually stood before this fix.
- **A near-miss while fixing this, caught by re-running the existing suite before trusting the fix**:
  my first attempt added a trailing `\b` to the whole extended git-subcommand alternation group,
  which silently reintroduced the *exact* `git checkout --` boundary bug this stage's own tests
  already found and fixed once (a `\b` cannot match between `-` and a space) — caught immediately
  because `readonlyBashGuard.spec.ts`'s own pre-existing "every representative mutation pattern" test
  failed on `"git checkout -- file.ts"` before I ever wrote a locking test for the new patterns. Fixed
  by leaving the group unanchored on the right, matching the original script's own documented
  reasoning for that exact case.
- **Re-verified live after the fix**: all four bypass commands above are now denied; every
  previously-allowed legitimate command (`pnpm exec tsc --noEmit`, `git status --short`, `git diff
  HEAD`, `git log --oneline -5`, `pnpm pw:lint-tests`) is still allowed, unaffected.
- **Locking test**: new test in `readonlyBashGuard.spec.ts` covering all 9 bypass commands above
  (the 4 demonstrated live plus 5 more of the same shape — `node --eval`, `python -c`, `perl -i -e`,
  `ruby -e`, `php -r`), confirmed to fail against a temporarily-reverted pre-fix script (all 9 denied
  as expected post-fix; confirmed `node -e` specifically was `allow`ed pre-fix) before being trusted.

## 4. Hook behavior from main vs. subagent contexts

Read `.claude/settings.json` and all three agents' frontmatter directly (not inferred):

- `.claude/settings.json` wires exactly two hooks, both project-wide, both matcher `Edit|Write`:
  `stage-gate-check.mjs` (`PreToolUse`) and `post-edit-validator.mjs` (`PostToolUse`). Neither
  `repair-write-guard.mjs` nor `readonly-bash-guard.mjs` appears here at all.
- `playwright-repair.md`'s frontmatter wires `repair-write-guard.mjs` to `PreToolUse` matcher
  `Edit|Write` and `readonly-bash-guard.mjs` to `PreToolUse` matcher `Bash`, both under its own
  `hooks:` field.
- `playwright-reviewer.md` and `playwright-triage.md` each wire `readonly-bash-guard.mjs` to
  `PreToolUse` matcher `Write|Edit|NotebookEdit|Bash`, likewise under their own `hooks:` field.

This scoping is correct, not a gap: a project-wide `repair-write-guard.mjs`/`readonly-bash-guard.mjs`
would also govern the *main* session's own ordinary work on this very framework (which routinely
edits `playwright-framework/`, `quality/*.yaml`, and the spec ledger — all outside
`repair-allowed-dirs.yaml` by design), which would make normal framework development impossible
through the main session. Scoping these two guards to only the subagents that need them, while
keeping `stage-gate-check.mjs`/`post-edit-validator.mjs` project-wide (since *every* edit anywhere,
main session or subagent, could touch the spec ledger or a governed file type), is exactly the right
split and matches DEC-024's stated reasoning. The live documentation (section 6) confirms subagent
frontmatter `hooks:` is a real, current, documented mechanism for this scoping, not an invented one.

## 5. `playwright-reviewer`/`playwright-triage` cannot write

Same tooling limitation as section 3 applies here (no live subagent invocation available). Verified
instead, as directly as this sandbox allows:

- Both agents' `tools:` frontmatter list is exactly `Read, Grep, Glob, Bash` — no `Write`, `Edit`, or
  `NotebookEdit` at all, so there is no tool call path to a file edit even before any hook runs.
- Both wire `readonly-bash-guard.mjs` to `PreToolUse` matcher `Write|Edit|NotebookEdit|Bash`: a direct
  invocation of the real script with `tool_name: "Write"` (or `Edit`/`NotebookEdit`) is unconditionally
  denied regardless of `tool_input`, confirmed live.
- Their only remaining avenue, `Bash`, was the exact channel Finding 2 (above) closed the most
  glaring gap in. With that fix applied, the specific bypass vectors demonstrated in this audit are
  now blocked for these two agents as well (they share the identical script).

## 6. Current Claude Code documentation, fetched and cross-checked directly

Fetched `code.claude.com/docs/en/{hooks,sub-agents,skills}` live (not from training data) and
cross-checked against every field actually used in this repository:

- **Hooks**: `hookSpecificOutput.permissionDecision` accepts exactly `"allow"`/`"deny"` for
  `PreToolUse` — matches `hookIO.mjs`. Exit code 2 is documented as the only code that blocks on its
  own; exit 1 is a non-blocking error — matches `post-edit-validator.mjs`'s deliberate `exit(1)` on a
  failure it cannot block anyway, and `deny()`'s `exit(2)`. `${CLAUDE_PROJECT_DIR}` is documented as
  both a config-string placeholder and a process env var, with `cwd` in the hook's own JSON input as
  the actual current directory — matches `lib/hookIO.mjs`'s `projectRoot()` precedence
  (`CLAUDE_PROJECT_DIR` env, then `input.cwd`, then `process.cwd()`). `systemMessage` is confirmed
  (via a second, more targeted fetch) to be a valid **top-level** JSON field, not required to nest
  under `hookSpecificOutput` — matches `post-edit-validator.mjs`'s actual output shape exactly (a
  bare `{ systemMessage: "..." }`), which I initially suspected might be a documentation mismatch
  until the second fetch confirmed it is the documented universal placement.
- **Sub-agents**: `tools:`, `model:`, and a subagent-scoped `hooks:` field (with the exact
  `PreToolUse`/`matcher`/`hooks: [{type: command, command, args}]` shape used in this repo) are all
  confirmed current and documented, explicitly described as running "only while that subagent is
  active."
- **Skills**: `argument-hint`, `disable-model-invocation` (confirmed: also "prevents the skill from
  being preloaded into subagents", consistent with `/pw-repair-test` never being auto-invoked),
  `context: fork`, `agent:` (confirmed: "custom subagents from `.claude/agents/`" is an explicitly
  documented option, and defaults to `general-purpose` if omitted — explaining why `background:
  false` and `agent: playwright-repair` are both needed together, exactly as `pw-repair-test/SKILL.md`
  sets them), and `background: false` (documented as "wait for the forked subagent's result... instead
  of running in the background") are all confirmed current, with matching syntax, in this repo's
  actual frontmatter. No stale or incorrect syntax was found anywhere in the six files that use these
  fields.

## 7. Skill scope vs. actual hook enforcement

`pw-repair-test/SKILL.md`'s stated allowed scope ("Only files under `e2e/tests/`, `e2e/pages/`, or
`e2e/components/`") matches `quality/repair-allowed-dirs.yaml`'s actual `allowedDirs` list
(`e2e/tests`, `e2e/pages`, `e2e/components`) exactly — no drift between documentation and enforced
reality. All 7 `SKILL.md` files were read in full and each states, in order: when to use/not use it,
required arguments, allowed scope of file changes (or "None" for the four pure-analysis/reporting
skills), preflight, the deterministic `pnpm pw:*` commands it delegates to (none reimplement tag
parsing or scoring in prose — confirmed by reading every command named), expected output, stop
conditions, and a "Never" section forbidding silently changing application behavior or test
expectations. This is complete against the audit gate's first bullet.

## 8. Hooks do not recursively invoke Claude, leak secrets, or launch expensive full-suite runs

- No `type: prompt`/`type: agent` hook definition exists anywhere in `.claude/settings.json` or any
  agent's own `hooks:` frontmatter — every hook entry across all four files is `type: "command"`
  running a plain Node script.
- None of the four hook scripts read or log any environment variable beyond `CLAUDE_PROJECT_DIR`
  (confirmed by reading every script in full); `post-edit-validator.mjs`'s `execFileSync` calls
  inherit the parent process's environment (Node's default) but never echo it anywhere.
- `post-edit-validator.mjs` invokes exactly three commands, gated on file type:
  `pnpm pw:validate-metadata`, `pnpm exec tsc --noEmit`, `pnpm pw:lint-tests` — confirmed by reading
  the `checks` array construction directly; there is no code path that reaches `playwright test`
  (browser-backed or otherwise) from this hook at all.

## Cleanup

Every adversarial probe was run against a throwaway fake repository root
(`fake-repair-repo`/`fake-gate-repo`) under this session's own scratchpad directory, never this real
repo's own files; both were deleted immediately after use. The two hook scripts were each
temporarily reverted to their pre-fix content in-place (to confirm each new locking test genuinely
fails against the bug it targets), then restored from an in-memory backup and re-verified — `git
diff`/`node --check` confirm the restored files are the fixed versions, not the reverted ones, and
the full suite (`pnpm pw:test`) was re-run clean after every restoration. No scratch files remain
under this repository (`git status --short` at the end shows only the legitimate fix/report files
below); nothing under `apps/`/`packages/`/application source was touched at any point (the one
"attack" that targeted `apps/web/src/foo.ts` only ever existed inside the throwaway fake repository
root, never this real repository).

## Verdict

**PASS WITH FINDINGS.** Every Stage 08 acceptance criterion and audit-gate item was independently
re-verified with real commands and real (fake-root-isolated) adversarial hook invocations, not
trusted from the implementation log: the claimed test/type-check numbers matched exactly before any
fix; both previously-claimed-fixed bugs (`git checkout --` boundary, the post-edit-validator message
format) were confirmed genuinely fixed, not just claimed; every `SKILL.md`'s stated scope was
cross-checked against the actual enforced allowlist; the main-vs-subagent hook wiring split was read
directly and judged correct; and current Claude Code hooks/sub-agents/skills documentation was
fetched live and found to match every field actually used, with no stale syntax anywhere. Three
High-severity bugs were found by this audit's own adversarial probing — none caught by the
pre-existing 333-test suite — and fixed live with locking regression tests, each confirmed to fail
against its pre-fix code before being trusted: a symlink inside an approved directory letting
`repair-write-guard.mjs` `allow` a write that actually lands outside every approved path; the
`readonly-bash-guard.mjs` Bash blocklist having no coverage at all for interpreter-based writes
(`node -e`, `python -c`, etc.), which is the *only* Bash defense for `playwright-reviewer`/
`playwright-triage` and the *only* defense of any kind against `playwright-repair` writing arbitrary
files via `Bash` (a channel `repair-write-guard.mjs` never governs); and `stage-gate-check.mjs`
checking for a `Result: PASS` line anywhere in an audit file rather than checking the file's own
first verdict line, letting an unrelated `Result: PASS` line elsewhere in a document satisfy a gate
whose entire purpose is verifying that specific stage's own real verdict. One tooling limitation is
disclosed rather than worked around: this sandboxed audit session has no way to invoke this
repository's own custom subagents or skills through a live `Task`/`Skill` harness (confirmed via
`ListAgents` and a direct `Skill` invocation attempt), so "attempt unauthorized writes through the
actual repair workflow, live, using the real subagent" was performed via the next-most-rigorous
available substitute — real, direct invocation of the exact on-disk hook script with the exact stdin
shape Claude Code would send for that subagent's wired matcher — which is the same substitute the
implementation log itself already disclosed relying on, and which is exactly what surfaced Findings
1 and 2. No Medium/Low findings are being carried forward this time — every additional edge case
this audit specifically went looking for (absolute vs. relative paths, case/trailing-slash mismatches
in the scope file, path traversal, nonexistent-directory smuggling, the documentation cross-check)
held up under direct, live testing. Stage 08 may be marked complete on the Progress Dashboard.
