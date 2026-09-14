#!/usr/bin/env node
/**
 * Stage 08 -- Section 11.4 hook requirement #1: "A scoped pre-tool safeguard used by
 * /pw-repair-test that blocks writes outside approved test-framework paths unless the human
 * explicitly expands scope."
 *
 * Wired only into the `playwright-repair` subagent's own frontmatter (`.claude/agents/
 * playwright-repair.md`), matcher "Edit|Write" -- never into project-wide `.claude/settings.json`.
 * That scoping (a hook attached to one subagent's own frontmatter, per Claude Code's documented
 * "hooks scoped to this subagent" field) is deliberate: it means this guard only ever fires for
 * tool calls made by the one subagent /pw-repair-test forks into, and can never interfere with any
 * other work in this repository (including the rest of this very framework's own Stage 00-11
 * build, which routinely edits playwright-framework/, quality/*.yaml, and this spec file).
 *
 * Two independent conditions must both hold, or the write is denied:
 *
 *   1. The target path must fall under one of `quality/repair-allowed-dirs.yaml`'s committed,
 *      human-owned directories (today: e2e/tests, e2e/pages, e2e/components -- deliberately
 *      excluding e2e/fixtures, e2e/data, e2e/support, all of playwright-framework/, quality/*.yaml,
 *      package.json, playwright.config.ts, and application source under apps//packages/). This
 *      hook never writes that file itself and refuses to honor it if it looks tampered with in a
 *      way that would need to invent a directory not already on disk (see the on-disk-directory
 *      check below) -- expanding it is a human editing the repo directly, not an assistant action.
 *   2. The target path must also appear in `artifacts/playwright/repair-scope.json`'s
 *      `approvedPaths`, an ephemeral (gitignored) per-session file `/pw-repair-test`'s own preflight
 *      step writes ONLY after the human has explicitly confirmed the one file being repaired. This
 *      is the "unless the human explicitly expands scope" half of the requirement: even fully
 *      within the outer allowed directories, nothing is writable until a session has named it.
 *
 * A Write is additionally refused unless the target file already exists -- repair modifies an
 * already-identified failing test, it does not author new ones (that is /pw-author-test's job).
 *
 * Stage 09 -- Section 09 acceptance criterion: "Repair cannot broaden selectors, remove
 * assertions, add sleeps, or skip a test without explicit justified review." The canonical check
 * for this (checkTestSource, playwright-framework/validation/lintRules.ts) is TypeScript and needs
 * a build step this dependency-free .mjs hook cannot take on -- see that module and
 * PLAYWRIGHT_TESTING.md's Stage 09 section for why. `assessDiffRisk` below is a deliberately
 * coarser, self-contained regex-based PROXY living directly in this hook: it compares the file's
 * real current content against what this Edit/Write would make it, flags a small, named set of
 * risky patterns, and requires each one to have a matching, human-reasoned entry in this session's
 * own `repair-scope.json` under `justifiedExceptions` (populated only after the human is asked
 * specifically about that additional risk -- see .claude/skills/pw-repair-test/SKILL.md). This is
 * an intentional second, coarser safety net alongside (never instead of) the canonical
 * `pw:lint-tests` check `post-edit-validator.mjs` already runs post-edit.
 *
 * Stage 09 -- Section 09 tasks "Prohibit repair for probable application defects and insufficient-
 * evidence outcomes" and "Require explicit test ID and maintenance recommendation for
 * /pw-repair-test": this hook does not trust a skill's own prose to honor that -- it independently
 * loads the most recently generated `artifacts/playwright/maintenance/*.json` report, finds the
 * finding whose own "Test source" evidence link names this file, and denies unless that finding's
 * own `repairAllowed` is `true`. No matching maintenance finding at all is ALSO denied (no triage
 * yet means no repair yet) -- this is the mechanical enforcement of a maintenance recommendation
 * actually existing, not just the skill remembering to check one.
 *
 * Fails safe throughout: any missing file, unparseable YAML/JSON, or absent field denies the
 * write rather than guessing a permissive default.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { readStdinJson, projectRoot, allow, deny, noop } from "./lib/hookIO.mjs";

// --- Stage 09 diff-safety proxy (see module doc above) -----------------------------------------
const ASSERTION_RE = /\bexpect(?:\.poll)?\s*\(/g;
const FIXED_WAIT_RE = /\.waitForTimeout\s*\(/g;
const SKIP_ONLY_FIXME_RE = /\.(?:only|skip|fixme)\s*\(/g;
const RAW_SELECTOR_RE = /\bpage\.(?:locator|\$\$?|getBy\w+)\s*\(/g;

function countMatches(re, text) {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** Returns `[{category, detail}]` for every risky pattern this edit would introduce/worsen in
 * `relPath`. An empty array means nothing here needs a justified exception. */
function assessDiffRisk(oldText, newText, relPath) {
  const categories = [];
  const isPageOrComponent = relPath.startsWith("e2e/pages/") || relPath.startsWith("e2e/components/");
  const isTestSpec = relPath.startsWith("e2e/tests/");

  const oldAssertions = countMatches(ASSERTION_RE, oldText);
  const newAssertions = countMatches(ASSERTION_RE, newText);
  if (newAssertions < oldAssertions) {
    categories.push({
      category: "assertion-count-decrease",
      detail: `expect(...)/expect.poll(...) call count dropped from ${oldAssertions} to ${newAssertions}`,
    });
  }

  const oldFixedWait = countMatches(FIXED_WAIT_RE, oldText);
  const newFixedWait = countMatches(FIXED_WAIT_RE, newText);
  if (newFixedWait > oldFixedWait) {
    categories.push({
      category: "new-fixed-wait",
      detail: `.waitForTimeout(...) call count increased from ${oldFixedWait} to ${newFixedWait}`,
    });
  }

  const oldSkip = countMatches(SKIP_ONLY_FIXME_RE, oldText);
  const newSkip = countMatches(SKIP_ONLY_FIXME_RE, newText);
  if (newSkip > oldSkip) {
    categories.push({
      category: "new-skip-only-or-fixme",
      detail: `.only(...)/.skip(...)/.fixme(...) call count increased from ${oldSkip} to ${newSkip}`,
    });
  }

  if (isTestSpec) {
    const oldRaw = countMatches(RAW_SELECTOR_RE, oldText);
    const newRaw = countMatches(RAW_SELECTOR_RE, newText);
    if (newRaw > oldRaw) {
      categories.push({
        category: "new-raw-selector-in-test",
        detail:
          `raw page.locator()/page.$()/page.getBy...() call count increased from ${oldRaw} to ${newRaw} inside ` +
          `a test file -- interactions should go through a page/component object, and a new raw call here is ` +
          `also this hook's coarse proxy for "a selector may have been broadened"`,
      });
    }
  }

  if (isPageOrComponent) {
    categories.push({
      category: "page-object-or-component-change",
      detail:
        `"${relPath}" is a shared page/component object -- ANY change here is always flagged as a proxy for ` +
        `"a locator may have been broadened", since this coarse regex-based hook cannot itself judge whether ` +
        `a locator became stricter or looser`,
    });
  }

  return categories;
}

const parsed = readStdinJson();
if (!parsed.ok) {
  deny(`repair-write-guard: refusing (malformed hook input) -- ${parsed.error}`);
}
const input = parsed.value;

const toolName = input.tool_name;
if (toolName !== "Edit" && toolName !== "Write") {
  // Not ours to police (defensive fallback; the subagent frontmatter matcher already restricts to
  // Edit|Write, so this only matters if the hook is ever invoked directly with a different tool).
  noop(`repair-write-guard: ignoring unrelated tool "${toolName}"`);
}

const toolInput = input.tool_input;
const filePath = toolInput && toolInput.file_path;
if (!filePath || typeof filePath !== "string") {
  deny("repair-write-guard: refusing -- tool_input.file_path is missing from hook input");
}

const root = resolve(projectRoot(input));
const resolvedTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);

function isWithin(candidate, dir) {
  return candidate === dir || candidate.startsWith(dir + sep);
}

if (!isWithin(resolvedTarget, root)) {
  deny(`repair-write-guard: refusing -- "${filePath}" resolves outside the repository root entirely`);
}
const relPath = relative(root, resolvedTarget).split(sep).join("/");

// --- Condition 1: the committed, human-owned outer directory allowlist -----------------------
const allowedDirsPath = join(root, "quality/repair-allowed-dirs.yaml");
if (!existsSync(allowedDirsPath)) {
  deny("repair-write-guard: refusing -- quality/repair-allowed-dirs.yaml does not exist");
}
let allowedDirsDoc;
try {
  allowedDirsDoc = parseYaml(readFileSync(allowedDirsPath, "utf-8"));
} catch (err) {
  deny(`repair-write-guard: refusing -- quality/repair-allowed-dirs.yaml is not valid YAML (${err.message})`);
}
const allowedDirs = allowedDirsDoc && Array.isArray(allowedDirsDoc.allowedDirs) ? allowedDirsDoc.allowedDirs : null;
if (!allowedDirs || allowedDirs.length === 0) {
  deny("repair-write-guard: refusing -- quality/repair-allowed-dirs.yaml has no allowedDirs list");
}
// Every configured directory must genuinely exist on disk as a real directory -- a nonexistent
// entry could otherwise be used to smuggle in a path that merely starts with the same string
// (e.g. an "e2e/tests-evil" sibling) without ever being a real, reviewable directory.
const validAllowedDirs = allowedDirs.filter((d) => {
  const abs = join(root, d);
  return existsSync(abs) && statSync(abs).isDirectory();
});
const underAllowedDir = validAllowedDirs.some((d) => isWithin(resolvedTarget, join(root, d)));
if (!underAllowedDir) {
  deny(
    `repair-write-guard: refusing -- "${relPath}" is outside the approved test-framework paths ` +
      `(${validAllowedDirs.join(", ")}); expand quality/repair-allowed-dirs.yaml yourself to ` +
      `broaden this -- the assistant will never widen it on its own`,
  );
}

// --- Condition 2: this session's explicit, human-confirmed scope ------------------------------
const scopePath = join(root, "artifacts/playwright/repair-scope.json");
if (!existsSync(scopePath)) {
  deny(
    "repair-write-guard: refusing -- no repair scope has been established for this session yet " +
      "(artifacts/playwright/repair-scope.json is missing); run /pw-repair-test's preflight, " +
      "which requires explicit human confirmation of the exact file to repair, first",
  );
}
let scopeDoc;
try {
  scopeDoc = JSON.parse(readFileSync(scopePath, "utf-8"));
} catch (err) {
  deny(`repair-write-guard: refusing -- artifacts/playwright/repair-scope.json is not valid JSON (${err.message})`);
}
const approvedPaths = Array.isArray(scopeDoc.approvedPaths) ? scopeDoc.approvedPaths : null;
if (!approvedPaths || approvedPaths.length === 0) {
  deny("repair-write-guard: refusing -- repair-scope.json has no approvedPaths");
}
if (!approvedPaths.includes(relPath)) {
  deny(
    `repair-write-guard: refusing -- "${relPath}" is not in this session's approved repair scope ` +
      `(approved: ${approvedPaths.join(", ")})`,
  );
}

// --- Write may only modify an already-existing file, never author a new one -------------------
if (!existsSync(resolvedTarget)) {
  deny(
    `repair-write-guard: refusing -- "${relPath}" does not exist yet; repair may only modify an ` +
      `already-existing, already-approved test-framework file, never create a new one`,
  );
}

// --- Symlink defense: the target (or any directory in its path) must not resolve elsewhere ------
// Stage 08 audit finding (High, fixed): every check above operates on the plain, non-symlink-
// aware resolved path. If a symlink already existed inside an allowed directory (e.g.
// e2e/tests/looks-legit.spec.ts pointing at apps/web/src/something.ts), every condition above would
// still pass -- the path string itself is under an allowed dir and can be named in
// repair-scope.json -- while the actual write lands wherever the symlink points, entirely outside
// the approved scope. Reproduced live: a real symlink under e2e/tests/ to a file outside every
// allowed directory was `allow`ed by the pre-fix script. Comparing the fully resolved (symlink-
// following) real path against the plain, non-symlink-following resolved path catches this for the
// target file itself and for any symlinked directory earlier in the path (repair-allowed-dirs.yaml's
// own directories are separately confirmed to be real directories above, but a symlink could still
// appear one level deeper, e.g. e2e/tests/some-symlinked-subdir/file.spec.ts).
let realRoot;
try {
  realRoot = realpathSync(root);
} catch (err) {
  deny(`repair-write-guard: refusing -- could not resolve the real path of the repository root (${err.message})`);
}
let realTarget;
try {
  realTarget = realpathSync(resolvedTarget);
} catch (err) {
  deny(`repair-write-guard: refusing -- could not resolve the real path of "${relPath}" (${err.message})`);
}
// Compare against the root's OWN real path plus the same relative path, not against the plain
// resolvedTarget -- so a project root that is itself reached via a symlink (e.g. CLAUDE_PROJECT_DIR
// pointing through a symlinked mount) is not mistaken for a target-side symlink escape.
const expectedRealTarget = resolve(realRoot, relPath);
if (realTarget !== expectedRealTarget) {
  deny(
    `repair-write-guard: refusing -- "${relPath}" is a symlink or contains one in its path ` +
      `(resolves to "${realTarget}", expected "${expectedRealTarget}"); repair may only write to a ` +
      `real, non-symlinked file inside the approved scope`,
  );
}

// --- Stage 09 diff-safety check: repair cannot broaden selectors, remove assertions, add sleeps,
// or skip a test without explicit justified review ---------------------------------------------
const currentContent = readFileSync(resolvedTarget, "utf-8");
let candidateNewContent;
if (toolName === "Write") {
  if (typeof toolInput.content !== "string") {
    deny("repair-write-guard: refusing -- Write tool_input.content is missing or not a string");
  }
  candidateNewContent = toolInput.content;
} else {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = toolInput;
  if (typeof oldString !== "string" || typeof newString !== "string") {
    deny("repair-write-guard: refusing -- Edit tool_input.old_string/new_string is missing or not a string");
  }
  if (!currentContent.includes(oldString)) {
    deny(
      `repair-write-guard: refusing -- could not locate old_string in the real, current content of ` +
        `"${relPath}" to assess diff safety; refusing out of caution`,
    );
  }
  candidateNewContent = replaceAll
    ? currentContent.split(oldString).join(newString)
    : currentContent.replace(oldString, newString);
}

const riskCategories = assessDiffRisk(currentContent, candidateNewContent, relPath);
if (riskCategories.length > 0) {
  const justifiedExceptions = Array.isArray(scopeDoc.justifiedExceptions) ? scopeDoc.justifiedExceptions : [];
  const unjustified = riskCategories.filter(
    (risk) =>
      !justifiedExceptions.some(
        (exception) =>
          exception &&
          exception.category === risk.category &&
          typeof exception.reason === "string" &&
          exception.reason.trim().length > 0,
      ),
  );
  if (unjustified.length > 0) {
    deny(
      `repair-write-guard: refusing -- this edit to "${relPath}" was flagged by the repair diff-safety check ` +
        `(${unjustified.map((r) => `${r.category}: ${r.detail}`).join("; ")}); a repair cannot broaden selectors, ` +
        `remove assertions, add sleeps, or skip a test without explicit justified review -- add a matching entry ` +
        `to artifacts/playwright/repair-scope.json's justifiedExceptions (each {category, reason}, one per ` +
        `flagged category above) only after asking the human specifically about this additional risk`,
    );
  }
}

// --- Stage 09: the most recent maintenance report must actually classify this test as
// repair-allowed -- mechanical enforcement of "prohibit repair for probable application defects
// and insufficient-evidence outcomes" and "require ... a maintenance recommendation" ---------------
const maintenanceDir = join(root, "artifacts/playwright/maintenance");
let maintenanceFiles;
try {
  maintenanceFiles = readdirSync(maintenanceDir).filter((f) => f.endsWith(".json"));
} catch {
  maintenanceFiles = [];
}
if (maintenanceFiles.length === 0) {
  deny(
    "repair-write-guard: refusing -- no maintenance report exists under artifacts/playwright/maintenance/; " +
      `run \`pnpm pw:triage\` first so a real classification exists for "${relPath}" before repairing it`,
  );
}
let latestReportPath;
let latestMtimeMs = -Infinity;
for (const file of maintenanceFiles) {
  const abs = join(maintenanceDir, file);
  const mtimeMs = statSync(abs).mtimeMs;
  if (mtimeMs > latestMtimeMs) {
    latestMtimeMs = mtimeMs;
    latestReportPath = abs;
  }
}
let maintenanceDoc;
try {
  maintenanceDoc = JSON.parse(readFileSync(latestReportPath, "utf-8"));
} catch (err) {
  deny(
    `repair-write-guard: refusing -- the most recent maintenance report ` +
      `(${relative(root, latestReportPath)}) is not valid JSON (${err.message})`,
  );
}
const findings = Array.isArray(maintenanceDoc.findings) ? maintenanceDoc.findings : [];
const matchingFinding = findings.find(
  (finding) =>
    finding &&
    Array.isArray(finding.evidenceLinks) &&
    finding.evidenceLinks.some((link) => link && link.path === relPath),
);
if (!matchingFinding) {
  deny(
    `repair-write-guard: refusing -- the most recent maintenance report ` +
      `(${relative(root, latestReportPath)}) contains no finding whose test source is "${relPath}"; ` +
      "run `pnpm pw:triage` against a run that actually covers this test's failure, then retry",
  );
}
if (matchingFinding.repairAllowed !== true) {
  deny(
    `repair-write-guard: refusing -- the most recent maintenance report classifies this test as ` +
      `"${matchingFinding.classification}" with repairAllowed: ${matchingFinding.repairAllowed} -- Stage 09's ` +
      "acceptance criteria prohibit repair here, and this hook enforces that verdict mechanically rather " +
      "than relying on a skill's own prose to check it",
  );
}

allow(`repair-write-guard: "${relPath}" is within the approved test-framework paths and this session's approved repair scope`);
