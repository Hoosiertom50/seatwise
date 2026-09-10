#!/usr/bin/env node
/**
 * Stage 08 -- Section 11.4 hook requirement #3: "A scoped stop/stage-gate check used by
 * /pw-bootstrap that prevents a stage from being declared complete without a passing audit
 * artifact and resolved findings."
 *
 * Wired project-wide in `.claude/settings.json` as a PreToolUse hook matching Edit|Write, so it
 * applies from the main session and from any subagent alike ("Test hook behavior from main and
 * subagent contexts", Stage 08 audit gate). "Scoped" here means scoped to one file: the very first
 * thing this script does is compute what `PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md`'s content would
 * become if this edit were applied, and if the target file isn't that one, it gets out of the way
 * immediately (a fast no-op for the overwhelming majority of Edit/Write calls in this repository).
 *
 * The rule it enforces: for every Progress Dashboard line this edit would leave checked
 * (`- [x] Stage NN - ...`), `quality/audits/stage-NN-audit.md` must already exist and its content
 * must contain a line starting `Result: PASS` (matching every real audit file this framework has
 * written so far, from stage-00 through stage-07 -- see PLAYWRIGHT_TESTING.md's Stage 08 section
 * for the exact convention this depends on). A stage carrying disclosed, deliberately-left-open
 * findings still writes `Result: PASS WITH FINDINGS`, which this regex also accepts -- only a
 * verdict that is NOT already a form of "PASS" (or an audit file that doesn't exist yet) blocks.
 *
 * Fails safe: any input this script cannot fully make sense of (missing fields, an Edit whose
 * old_string cannot be located in the file's current real content) is treated as unable to verify
 * safety and denied, rather than assumed fine.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readStdinJson, projectRoot, allow, deny, noop } from "./lib/hookIO.mjs";

const SPEC_FILE = "PLAYWRIGHT_QUALITY_FRAMEWORK_SPEC.md";

const parsed = readStdinJson();
if (!parsed.ok) {
  deny(`stage-gate-check: refusing (malformed hook input) -- ${parsed.error}`);
}
const input = parsed.value;

const toolName = input.tool_name;
if (toolName !== "Edit" && toolName !== "Write") {
  noop(`stage-gate-check: ignoring unrelated tool "${toolName}"`);
}

const toolInput = input.tool_input;
const filePath = toolInput && toolInput.file_path;
if (!filePath || typeof filePath !== "string") {
  deny("stage-gate-check: refusing -- tool_input.file_path is missing from hook input");
}

const root = resolve(projectRoot(input));
const resolvedTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
const relPath = relative(root, resolvedTarget).split(sep).join("/");

if (relPath !== SPEC_FILE) {
  // The fast path: not the ledger, nothing for this gate to check.
  noop(`stage-gate-check: "${relPath}" is not ${SPEC_FILE}, nothing to check`);
}

if (!existsSync(resolvedTarget)) {
  deny(`stage-gate-check: refusing -- cannot verify the stage gate, ${SPEC_FILE} does not exist on disk`);
}
const currentContent = readFileSync(resolvedTarget, "utf-8");

let resultingContent;
if (toolName === "Write") {
  if (typeof toolInput.content !== "string") {
    deny("stage-gate-check: refusing -- Write tool_input.content is missing or not a string");
  }
  resultingContent = toolInput.content;
} else {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = toolInput;
  if (typeof oldString !== "string" || typeof newString !== "string") {
    deny("stage-gate-check: refusing -- Edit tool_input.old_string/new_string is missing or not a string");
  }
  if (!currentContent.includes(oldString)) {
    deny(
      `stage-gate-check: refusing -- could not locate old_string in the real, current content of ` +
        `${SPEC_FILE} to verify the resulting stage-gate state; refusing out of caution`,
    );
  }
  resultingContent = replaceAll
    ? currentContent.split(oldString).join(newString)
    : currentContent.replace(oldString, newString);
}

const CHECKED_STAGE_RE = /^-\s*\[x\]\s*Stage\s+(\d{2})\b/gim;
const checkedStages = new Set();
let match;
while ((match = CHECKED_STAGE_RE.exec(resultingContent)) !== null) {
  checkedStages.add(match[1]);
}

const violations = [];
for (const stageNo of checkedStages) {
  const auditPath = resolve(root, `quality/audits/stage-${stageNo}-audit.md`);
  if (!existsSync(auditPath)) {
    violations.push(
      `Stage ${stageNo} would be marked complete on the Progress Dashboard but ` +
        `quality/audits/stage-${stageNo}-audit.md does not exist yet`,
    );
    continue;
  }
  const auditContent = readFileSync(auditPath, "utf-8");
  // Stage 08 audit finding (High, fixed): this used to test whether a "Result: PASS" line existed
  // ANYWHERE in the file (`/^Result:\s*PASS\b/m.test(auditContent)`), rather than checking the
  // file's own actual, first verdict line. Reproduced live: an audit file whose real, first verdict
  // line honestly says "Result: FAIL (blocking findings unresolved)" but which also happens to
  // contain an unrelated line elsewhere starting with "Result: PASS" (e.g. an appendix quoting this
  // project's own house style as an example) was `allow`ed by the pre-fix script -- exactly the
  // failure mode this gate exists to prevent. Fixed by finding the FIRST line in the file that
  // starts with "Result:" at all, and checking only that one's value -- matching the documented
  // convention (DEC-026: every real audit "opens with ... Result: PASS...") rather than a substring
  // search over the whole document.
  const firstResultLine = auditContent.match(/^Result:\s*(.*)$/m);
  if (!firstResultLine || !/^PASS\b/.test(firstResultLine[1])) {
    violations.push(
      `quality/audits/stage-${stageNo}-audit.md exists but its own first "Result:" line does not ` +
        `start with "PASS" -- the audit gate requires a passing verdict before Stage ${stageNo} can ` +
        `be marked complete`,
    );
  }
}

if (violations.length > 0) {
  deny(`stage-gate-check: refusing -- ${violations.join("; ")}`);
}

allow(
  checkedStages.size > 0
    ? `stage-gate-check: every newly-checked stage (${[...checkedStages].join(", ")}) has a passing audit artifact`
    : "stage-gate-check: this edit does not check any new Progress Dashboard stage box",
);
