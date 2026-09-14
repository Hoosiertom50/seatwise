#!/usr/bin/env node
/**
 * Stage 08 -- enforces the Section 11.3/acceptance-criteria requirement "Reviewer and triage
 * agents cannot edit files" as defense in depth beyond simply omitting Write/Edit/NotebookEdit
 * from their `tools:` frontmatter. Wired into three different subagents' own frontmatter
 * (`.claude/agents/{playwright-reviewer,playwright-triage,playwright-repair}.md`), never into
 * project-wide `.claude/settings.json` -- like repair-write-guard.mjs, subagent-scoped wiring
 * means this can never interfere with the main session's own ordinary work.
 *
 * Two independent uses of the same script, selected by which matcher a given subagent wires it to:
 *
 *   - `playwright-reviewer` and `playwright-triage` wire this to matcher "Write|Edit|NotebookEdit|
 *     Bash": any Write/Edit/NotebookEdit call is denied unconditionally (their tools list already
 *     excludes these, so this only matters if that list is ever misconfigured later), and any Bash
 *     call is checked against MUTATION_PATTERNS below.
 *   - `playwright-repair` wires this to matcher "Bash" only (its Write/Edit calls go through the
 *     separate, scope-aware repair-write-guard.mjs instead): this still forces every file mutation
 *     that subagent makes through the Edit/Write tools -- which repair-write-guard.mjs can actually
 *     reason about against the approved scope -- rather than an arbitrary shell command that would
 *     bypass that scoping entirely.
 *
 * MUTATION_PATTERNS is a documented, intentionally conservative blocklist, not a sandbox: Claude
 * Code does not offer per-command Bash sandboxing today, so this cannot promise a determined,
 * adversarial prompt can never construct a command it misses. It is sufficient to catch the
 * overwhelming majority of accidental or careless mutation attempts from an agent whose entire
 * system prompt and tool list already assume it never writes anything -- consistent with this
 * framework's own risk-acceptance style elsewhere (e.g. DEC-018's disclosed, accepted limitation).
 */
import { readStdinJson, deny, allow, noop } from "./lib/hookIO.mjs";

const MUTATION_PATTERNS = [
  { re: />>?(?!=)/, label: "shell output redirection (> or >>)" },
  { re: /:>/, label: "the `:>` truncate-a-file idiom" },
  { re: /\brm\b/, label: "rm" },
  { re: /\bmv\b/, label: "mv" },
  { re: /\bcp\b/, label: "cp" },
  { re: /\bsed\s+-i\b/, label: "sed -i (in-place edit)" },
  { re: /\btee\b/, label: "tee" },
  { re: /\btouch\b/, label: "touch" },
  { re: /\bmkdir\b/, label: "mkdir" },
  { re: /\bchmod\b/, label: "chmod" },
  { re: /\bchown\b/, label: "chown" },
  { re: /\bdd\b/, label: "dd" },
  { re: /\btruncate\b/, label: "truncate" },
  { re: /\bunlink\b/, label: "unlink" },
  // No trailing \b: "checkout --" ends on two non-word characters ("-" then a space), so a \b
  // there would never match at all (a word boundary requires one word char and one non-word char
  // on either side) -- confirmed live against "git checkout -- file.ts" before fixing this.
  // Deliberately no trailing \b on the whole group (see the "checkout --" comment above -- the
  // same reasoning applies to every alternative here, so the group is left unanchored on the right
  // rather than repeating that mistake for one alternative and not the others).
  {
    re: /\bgit\s+(add|commit|push|checkout\s+--|reset|clean|rm|restore|apply|stash\s+pop|merge|rebase|cherry-pick)/,
    label: "a mutating git subcommand",
  },
  { re: /\bn?pm\s+publish\b/, label: "package publish" },
  { re: /\bln\b/, label: "ln (creates a symlink/hardlink, a path-escape vector into e2e/pages etc.)" },
  // Stage 08 audit finding (High, fixed): the patterns above only ever matched shell-level mutation
  // syntax (redirection, named coreutils). An agent can write an arbitrary file's *content* through
  // any interpreter's own inline-eval flag without a single one of those characters or words ever
  // appearing -- e.g. `node -e "require('fs').writeFileSync('apps/web/src/x.ts','pwned')"` or
  // `python3 -c "open('e2e/pages/Foo.ts','w').write('pwned')"` matched NOTHING above and was
  // allowed outright. Verified live against the pre-fix script for both playwright-reviewer/
  // playwright-triage (whose only Bash defense this is) and playwright-repair (for whom this is the
  // ONLY check on Bash at all -- repair-write-guard.mjs governs Edit/Write, never Bash). This is not
  // an exhaustive fix (no blocklist can enumerate every scripting language or obfuscation), but it
  // closes the specific, highly-likely vectors an agent reaching for "a quick script" would use.
  { re: /\bnode(?:js)?\s+(-e\b|--eval\b|-p\b|--print\b)/, label: "node inline eval (-e/--eval/-p/--print)" },
  { re: /\bpython3?\s+-c\b/, label: "python inline eval (-c)" },
  { re: /\bperl\s+(-\w*e\b|-\w*i\b)/, label: "perl inline eval/in-place edit (-e/-i)" },
  { re: /\bruby\s+-e\b/, label: "ruby inline eval (-e)" },
  { re: /\bphp\s+-r\b/, label: "php inline eval (-r)" },
  { re: /\bdeno\s+eval\b/, label: "deno inline eval" },
];

const parsed = readStdinJson();
if (!parsed.ok) {
  deny(`readonly-bash-guard: refusing (malformed hook input) -- ${parsed.error}`);
}
const input = parsed.value;
const toolName = input.tool_name;

if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
  deny(`readonly-bash-guard: refusing -- this agent is read-only and may never call ${toolName}`);
}

if (toolName !== "Bash") {
  // Defensive fallback for a matcher misconfiguration; nothing to police for any other tool.
  noop(`readonly-bash-guard: ignoring unrelated tool "${toolName}"`);
}

const command = input.tool_input && input.tool_input.command;
if (typeof command !== "string") {
  deny("readonly-bash-guard: refusing -- tool_input.command is missing from hook input");
}

const matched = MUTATION_PATTERNS.find((p) => p.re.test(command));
if (matched) {
  deny(`readonly-bash-guard: refusing -- command appears to mutate state (${matched.label}), which this agent may never do: ${command}`);
}

allow("readonly-bash-guard: command does not match any known mutation pattern");
